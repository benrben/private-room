import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useFrameTheme, withFrameTheme } from "./frameTheme";

/**
 * In-app "browser" for self-contained HTML files. The page is staged with the
 * backend and loaded from the `roomdoc://` custom scheme, which serves it at an
 * isolated origin with a strict CSP header: the page's OWN inline JS/CSS and
 * data: assets run (so interactive pages render fully, like a real browser),
 * but every network request is blocked — it can't phone home, and its opaque,
 * cross-origin frame can't touch the app, the room, or Tauri IPC.
 *
 * Why not a blob: URL (the previous approach)? WKWebView won't execute a
 * sandboxed blob: document's scripts, so JS-driven pages rendered blank. A real
 * scheme served by the backend runs them normally.
 *
 * For a page that needs external resources (CDN scripts, remote images), the
 * "Open in browser" button hands it to the user's default browser instead.
 *
 * THREE WAYS TO READ IT. A saved page is evidence as often as it is a page:
 * you want to see it, you want to read what it actually says, and sometimes
 * you want to see what it is made of. So the reader offers the rendered page,
 * the page's words with its markup taken off, and the source. All three come
 * from the SAME string — nothing is fetched, nothing is re-derived by a model,
 * and no mode can show anything the file does not contain.
 */

interface Props {
  source: string;
  name?: string;
}

/** Which reading of the page is on screen. */
type Mode = "page" | "text" | "source";

const MODES: { id: Mode; label: string; tip: string }[] = [
  { id: "page", label: "Page", tip: "The page as it was written, running in the sandbox" },
  { id: "text", label: "Text", tip: "The page's words, with its markup taken off" },
  { id: "source", label: "Source", tip: "The file's own HTML, exactly as stored" },
];

export default function HtmlView({ source, name }: Props) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [mode, setMode] = useState<Mode>("page");
  // "Opening…" flicking back to normal with nothing else on screen reads as
  // success; a failure has to say so.
  const [openErr, setOpenErr] = useState<string | null>(null);
  // The staged frame is an opaque origin, so its palette is written into the
  // markup rather than inherited. That makes the theme a real dependency of
  // staging: when it changes, the page has to be staged again.
  const theme = useFrameTheme();

  // Stage the page and load it from roomdoc://; if staging fails, fall back to
  // a sandboxed srcDoc so at least static content still shows.
  useEffect(() => {
    let alive = true;
    setUrl("");
    setFailed(false);
    api
      // Hand the app's theme in: the staged page is an opaque origin and
      // cannot read `data-theme` off the parent for itself. It only ever ADDS
      // the attribute — a page that themed itself keeps its own choice, which
      // is what stops a saved article being repainted into something its
      // author never wrote.
      .stagePreviewHtml(withFrameTheme(source))
      .then((token) => {
        if (alive) setUrl(`roomdoc://localhost/${token}`);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
    // `theme` is in here because withFrameTheme BAKES the palette into the
    // markup: without it a page staged in a dark room stayed charcoal after
    // the app went light, until the file was closed and reopened.
  }, [source, theme]);

  // Computed only when the reader is actually showing it — a large page is a
  // large parse, and most files are never read this way.
  const plain = useMemo(() => (mode === "text" ? textOf(source) : ""), [mode, source]);

  // Open the raw page in the real browser, where interactive pages AND external
  // resources render fully. Leaves the private sandbox — an explicit escape hatch.
  async function openInBrowser() {
    if (opening) return;
    setOpening(true);
    setOpenErr(null);
    try {
      await api.openHtmlInBrowser(name ?? "preview", source);
    } catch (e) {
      setOpenErr(
        `Couldn't hand this page to your browser — ${String(e)}. The in-app preview below still works.`,
      );
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="html-view">
      <div className="html-view-bar">
        {/* Toggle buttons rather than a tablist: these are three readings of
            one document, not three panels, and aria-pressed says exactly that
            without promising the arrow-key navigation a tablist owes. */}
        <span className="rdr-modes" role="group" aria-label="How to read this page">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="rdr-mode"
              aria-pressed={mode === m.id}
              title={m.tip}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </span>
        <span className="html-view-note rdr-note">
          Running in a sandbox — the page runs, but can't reach the network.
        </span>
        <span className="html-view-actions rdr-bar-end">
          <button
            className="nb-btn"
            title="Open this page in your default browser — allows external resources and leaves the private sandbox. Only for pages you trust."
            data-agent-blocked
            onClick={openInBrowser}
            disabled={opening}
          >
            {opening ? "Opening…" : "Open in browser ↗"}
          </button>
        </span>
      </div>
      {openErr && (
        <div className="gate-error" role="alert">
          {openErr}
        </div>
      )}
      {/* The frame stays mounted across mode switches and is hidden with the
          `hidden` attribute, which takes it out of the accessibility tree as
          well as off the screen. Remounting it would reload the page and throw
          away whatever state an interactive document had built up. */}
      {url ? (
        <iframe
          key={url}
          className="html-view-frame"
          hidden={mode !== "page"}
          sandbox="allow-scripts allow-modals"
          src={url}
          title="HTML preview"
        />
      ) : failed ? (
        <iframe
          className="html-view-frame"
          hidden={mode !== "page"}
          sandbox="allow-scripts allow-modals"
          srcDoc={withFrameTheme(source)}
          title="HTML preview"
        />
      ) : null}
      {mode === "text" && (
        <div className="html-text">
          {plain ? (
            <pre className="html-doc" dir="auto">
              {plain}
            </pre>
          ) : (
            <div className="empty-hint">
              This page has no text outside its markup — it may be built
              entirely by script, or be a single image.
            </div>
          )}
        </div>
      )}
      {mode === "source" && (
        <div className="html-src">
          <pre className="html-doc">{source}</pre>
        </div>
      )}
    </div>
  );
}

/** Contents that are code, not words. A stylesheet shown as the page's text
 * would read as something the page said. */
const TEXT_SKIP = new Set(["script", "style", "noscript", "template"]);

/** Elements that start their own line. Without these the whole page arrives
 * as one paragraph with words fused across every tag boundary. */
const TEXT_BLOCK = new Set([
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tr", "ul",
]);

/**
 * The page's words, with its markup taken off.
 *
 * `DOMParser` builds an INERT document: it has no browsing context, so nothing
 * in it executes and nothing in it fetches — the same primitive every HTML
 * sanitiser is built on, and the reason this mode does not weaken the sandbox
 * one bit. Nothing is ever assigned to `innerHTML`; the only things read back
 * out are text nodes.
 *
 * Nothing is summarised, filtered by "importance", or reordered: what comes
 * out is the document's own text in the document's own order. Runs of
 * whitespace collapse the way a browser collapses them when it lays the page
 * out — EXCEPT inside `<pre>`, where the author's spacing IS the content and
 * is passed through untouched.
 */
function textOf(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }

  const out: string[] = [];
  /** One blank line between blocks, never a stack of them. */
  const newline = () => {
    let run = 0;
    for (let i = out.length - 1; i >= 0 && out[i] === "\n"; i--) run++;
    if (run < 2) out.push("\n");
  };

  const walk = (node: Node, inPre: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? "";
      if (inPre) {
        out.push(raw);
        return;
      }
      const collapsed = raw.replace(/\s+/g, " ");
      // A lone space straight after a line break is layout, not text.
      if (collapsed === " " && (out.length === 0 || out[out.length - 1] === "\n")) return;
      if (collapsed) out.push(collapsed);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toLowerCase();
    if (TEXT_SKIP.has(tag)) return;
    if (tag === "br") {
      out.push("\n");
      return;
    }
    const block = TEXT_BLOCK.has(tag);
    if (block) newline();
    const pre = inPre || tag === "pre";
    for (const child of Array.from(node.childNodes)) walk(child, pre);
    if (block) newline();
  };

  walk(doc.body ?? doc.documentElement, false);
  return out.join("").trim();
}
