import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useFrameTheme, withFrameTheme } from "./frameTheme";
import { withSelectionReporter } from "./frameSelection";
import { textOf } from "./htmlText";

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

function useStagedPreview(source: string, theme: ReturnType<typeof useFrameTheme>) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
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
      .stagePreviewHtml(withSelectionReporter(withFrameTheme(source)))
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
  return { url, failed };
}

function useBrowserOpener(name: string | undefined, source: string) {
  const [opening, setOpening] = useState(false);
  // "Opening…" flicking back to normal with nothing else on screen reads as
  // success; a failure has to say so.
  const [openErr, setOpenErr] = useState<string | null>(null);

  async function openInBrowser() {
    if (opening) return;
    setOpening(true);
    setOpenErr(null);
    try {
      await api.openHtmlInBrowser(name ?? "preview", source);
    } catch (error) {
      setOpenErr(
        `Couldn't hand this page to your browser — ${String(error)}. The in-app preview below still works.`,
      );
    } finally {
      setOpening(false);
    }
  }

  return { opening, openErr, openInBrowser };
}

function ModeControls({ mode, setMode, opening, openInBrowser }: {
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  opening: boolean;
  openInBrowser: () => Promise<void>;
}) {
  return (
    <div className="html-view-bar">
      {/* Toggle buttons rather than a tablist: these are three readings of
          one document, not three panels, and aria-pressed says exactly that
          without promising the arrow-key navigation a tablist owes. */}
      <span className="rdr-modes" role="group" aria-label="How to read this page">
        {MODES.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className="rdr-mode"
            aria-pressed={mode === candidate.id}
            title={candidate.tip}
            onClick={() => setMode(candidate.id)}
          >
            {candidate.label}
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
  );
}

function PreviewFrame({ url, failed, mode, source }: {
  url: string;
  failed: boolean;
  mode: Mode;
  source: string;
}) {
  if (url) {
    return (
      <iframe
        key={url}
        className="html-view-frame"
        hidden={mode !== "page"}
        sandbox="allow-scripts allow-modals"
        src={url}
        title="HTML preview"
      />
    );
  }
  if (!failed) return null;
  return (
    <iframe
      className="html-view-frame"
      hidden={mode !== "page"}
      sandbox="allow-scripts allow-modals"
      srcDoc={withSelectionReporter(withFrameTheme(source))}
      title="HTML preview"
    />
  );
}

function TextReading({ mode, plain }: { mode: Mode; plain: string }) {
  if (mode !== "text") return null;
  if (!plain) {
    return (
      <div className="html-text">
        <div className="empty-hint">
          This page has no text outside its markup — it may be built entirely by script, or be a single image.
        </div>
      </div>
    );
  }
  return <div className="html-text"><pre className="html-doc" dir="auto">{plain}</pre></div>;
}

function SourceReading({ mode, source }: { mode: Mode; source: string }) {
  if (mode !== "source") return null;
  return <div className="html-src"><pre className="html-doc">{source}</pre></div>;
}

export default function HtmlView({ source, name }: Props) {
  // The staged frame is an opaque origin, so its palette is written into the
  // markup rather than inherited. That makes the theme a real dependency of
  // staging: when it changes, the page has to be staged again.
  const theme = useFrameTheme();
  const { url, failed } = useStagedPreview(source, theme);
  const { opening, openErr, openInBrowser } = useBrowserOpener(name, source);
  const [mode, setMode] = useState<Mode>("page");

  // Computed only when the reader is actually showing it — a large page is a
  // large parse, and most files are never read this way.
  const plain = useMemo(() => (mode === "text" ? textOf(source) : ""), [mode, source]);

  return (
    <div className="html-view">
      <ModeControls mode={mode} setMode={setMode} opening={opening} openInBrowser={openInBrowser} />
      {openErr && (
        <div className="gate-error" role="alert">
          {openErr}
        </div>
      )}
      {/* The frame stays mounted across mode switches and is hidden with the
          `hidden` attribute, which takes it out of the accessibility tree as
          well as off the screen. Remounting it would reload the page and throw
          away whatever state an interactive document had built up. */}
      <PreviewFrame url={url} failed={failed} mode={mode} source={source} />
      <TextReading mode={mode} plain={plain} />
      <SourceReading mode={mode} source={source} />
    </div>
  );
}
