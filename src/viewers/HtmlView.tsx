import { useEffect, useState } from "react";
import { api } from "../api";

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
 */

interface Props {
  source: string;
  name?: string;
}

export default function HtmlView({ source, name }: Props) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);

  // Stage the page and load it from roomdoc://; if staging fails, fall back to
  // a sandboxed srcDoc so at least static content still shows.
  useEffect(() => {
    let alive = true;
    setUrl("");
    setFailed(false);
    api
      .stagePreviewHtml(source)
      .then((token) => {
        if (alive) setUrl(`roomdoc://localhost/${token}`);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [source]);

  // Open the raw page in the real browser, where interactive pages AND external
  // resources render fully. Leaves the private sandbox — an explicit escape hatch.
  async function openInBrowser() {
    if (opening) return;
    setOpening(true);
    try {
      await api.openHtmlInBrowser(name ?? "preview", source);
    } catch {
      /* best-effort — the in-app preview still works */
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="html-view">
      <div className="html-view-bar">
        <span className="html-view-note">
          Running in a sandbox — the page runs, but can't reach the network.
        </span>
        <span className="html-view-actions">
          <button
            className="subtle"
            title="Open this page in your default browser — allows external resources and leaves the private sandbox. Only for pages you trust."
            data-agent-blocked
            onClick={openInBrowser}
            disabled={opening}
          >
            {opening ? "Opening…" : "Open in browser ↗"}
          </button>
        </span>
      </div>
      {url ? (
        <iframe
          key={url}
          className="html-view-frame"
          sandbox="allow-scripts allow-modals"
          src={url}
          title="HTML preview"
        />
      ) : failed ? (
        <iframe
          className="html-view-frame"
          sandbox="allow-scripts allow-modals"
          srcDoc={source}
          title="HTML preview"
        />
      ) : null}
    </div>
  );
}
