import { useMemo, useState } from "react";

/**
 * Live "runner" for HTML files. The source is rendered in a sandboxed iframe so
 * an opened page can't reach the app, the Tauri IPC, or the rest of the room:
 * the frame runs at a unique opaque origin (sandbox WITHOUT allow-same-origin),
 * so its scripts have no handle on our window.
 *
 * Privacy: by default we inject a strict Content-Security-Policy that blocks
 * every network request, so merely opening a file can never phone home or leak
 * that it was viewed. Self-contained pages (inline CSS/JS, data: images) run
 * fine; a page that pulls external resources shows nothing until the reader
 * explicitly clicks "Allow network" for this view.
 */

interface Props {
  source: string;
}

const BLOCK_NETWORK_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "media-src data: blob:; " +
  "font-src data:; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'";

/** Prepend a network-blocking CSP <meta> into the document's <head> so the
 * policy is in force before any resource can load. A CSP meta only applies from
 * inside <head>, so we splice after the opening tag when one exists and
 * synthesize a head otherwise. Multiple policies intersect, so this only ever
 * tightens a page that already ships its own CSP. */
function blockNetwork(source: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${BLOCK_NETWORK_CSP}">`;
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  }
  if (/<html[^>]*>/i.test(source)) {
    return source.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  }
  return `<!doctype html><head>${meta}</head>${source}`;
}

export default function HtmlView({ source }: Props) {
  const [allowNetwork, setAllowNetwork] = useState(false);
  const doc = useMemo(
    () => (allowNetwork ? source : blockNetwork(source)),
    [source, allowNetwork],
  );

  return (
    <div className="html-view">
      <div className="html-view-bar">
        <span className="html-view-note">
          {allowNetwork
            ? "Network allowed — this page can reach external resources."
            : "Running in a sandbox — network blocked for privacy."}
        </span>
        <button
          className="subtle"
          title={
            allowNetwork
              ? "Block this page from making any network request"
              : "Let this page load external resources (images, scripts, fonts). Only for pages you trust."
          }
          onClick={() => setAllowNetwork((v) => !v)}
        >
          {allowNetwork ? "Block network" : "Allow network"}
        </button>
      </div>
      {/* Re-key on the mode so toggling network fully reloads the frame. */}
      <iframe
        key={allowNetwork ? "net" : "safe"}
        className="html-view-frame"
        sandbox="allow-scripts allow-modals"
        srcDoc={doc}
        title="HTML preview"
      />
    </div>
  );
}
