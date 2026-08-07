import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { BrowserInfo, BrowserPageText } from "../apiTypes";
// The reading-progress hook lives beside the plain-text reader because it was
// written for it; it belongs in a module of its own and should move there.
import { useReadingProgress } from "../viewers/ProseView";
import { hostOf } from "./browserAnnounce";

/* Item #18: the page, as text you can actually read.
 *
 * WHY THIS IS THE HONEST ANSWER AND A LABEL ON THE STAGE IS NOT. The page is a
 * native child webview: a sibling NSView with its own process and its own
 * accessibility tree. `.browser-stage` is an empty hole whose only job is to
 * be measured — putting `aria-label="the web page"` on it would name a region
 * that contains nothing, which is a claim to assistive tech that this app can
 * show you the page when it cannot. So the stage stays out of the tree, and
 * the content comes from the one place that really has it: the same `read`
 * extractor the agent's `browse_read` uses, rendered as real HTML in the host.
 *
 * IT SHRINKS THE STAGE, IT DOES NOT COVER IT — the pattern the journal panel
 * already uses, and the one thing that must not change. The results page and
 * the start screen sit over a webview PARKED AT 1×1, and a WKWebView's layout
 * viewport is its frame: at one pixel wide the page reflows to tens of
 * thousands of pixels tall and the extractor's own visibility rule drops
 * nearly all of it. A reading view that parked the page would render a
 * fragment and call it the page. Rust refuses to read a parked page for
 * exactly this reason (`too_small_to_read`); this layout is what stops that
 * refusal from ever being the normal case.
 */

type Mode = "main" | "full";

interface Loaded {
  text: string;
  title: string;
  url: string;
  /** Where the next chunk starts, in the page script's own units. */
  next: number;
  total: number;
  truncated: boolean;
}

export function BrowserReader({
  info,
  onNavigate,
  onClose,
}: {
  info: BrowserInfo;
  /** A link in the text. Routed through the private browser, never the system
   *  browser — leaving the room's browser silently would be the one thing this
   *  whole area promises not to do. */
  onNavigate: (url: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("main");
  const [page, setPage] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // How far down the copy you have read. The panel is its own scroll region,
  // so this is the real scroll position and not an estimate.
  const read = useReadingProgress(bodyRef);

  const load = useCallback(async (which: Mode) => {
    setBusy(true);
    setError(null);
    try {
      const got: BrowserPageText = await api.browserPageText(which, 0);
      setPage({
        text: got.text ?? "",
        title: got.title ?? "",
        url: got.url ?? "",
        next: got.nextOffset ?? 0,
        total: got.total ?? 0,
        truncated: got.truncated === true,
      });
    } catch (e) {
      // Printed, never swallowed: a page that refuses the script (a PDF, a
      // strict-CSP site) must say so rather than render as a blank document
      // that reads like an empty page.
      setPage(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** The next slice, appended.
   *
   * One press, one chunk — never a loop until `truncated` goes false. The page
   * script re-walks the whole DOM for every call, so a long document costs a
   * full extraction per chunk, and a page that rewrites itself between them
   * would tile two different documents together. Bounded and user-driven is
   * the honest shape. */
  const more = useCallback(async () => {
    if (!page || !page.truncated) return;
    setBusy(true);
    try {
      const got: BrowserPageText = await api.browserPageText(mode, page.next);
      setPage((p) =>
        p === null
          ? p
          : {
              ...p,
              text: p.text + (got.text ?? ""),
              next: got.nextOffset ?? p.next,
              total: got.total ?? p.total,
              truncated: got.truncated === true,
            },
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [mode, page]);

  // Re-read whenever the page under us changes. The URL is the identity: a
  // reader still showing the previous page's text after a link was followed is
  // the same fabrication as a stale address bar, and worse, because there is
  // no repaint to give it away.
  useEffect(() => {
    void load(mode);
  }, [load, mode, info.url]);

  // The heading takes focus when the reader opens AND whenever the page under
  // it changes, so a screen reader starts reading the new page instead of
  // leaving the user to hunt for it. Following a link here replaces the whole
  // document: without this, focus falls to the body — the anchor that was
  // focused a moment ago no longer exists.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [info.url]);

  const host = hostOf(page?.url ?? info.url);
  const insecure = (page?.url ?? info.url ?? "").startsWith("http://");
  const shown = page ? page.text.length : 0;

  return (
    <section
      className="browser-reader"
      aria-label="Page as text"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      {/* Reading progress as a marker stroke across the top of the copy.
          aria-hidden and inert: the scroll position is already available to a
          keyboard or screen-reader user, and a live region announcing a
          percentage on every frame would make the panel unreadable. */}
      {read !== null && (
        <div
          className="rdr-progress"
          aria-hidden
          style={{ "--nb-val": `${read}%` } as React.CSSProperties}
        >
          <i />
        </div>
      )}
      <header className="browser-reader-head">
        {/* tabIndex -1 so the focus move on open lands somewhere meaningful
            without adding a tab stop nobody asked for. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <h1 ref={headingRef} tabIndex={-1} dir="auto">
          {page?.title?.trim() || info.title || "This page has no title"}
        </h1>
        <p className="browser-reader-where">
          <span>{host ?? page?.url ?? info.url ?? "no address"}</span>
          <span className="sep">·</span>
          {/* Whether the connection is encrypted is a STATE, so it is drawn as
              a strip of tape: red for urgent, green for verified, per the
              product-wide marker meanings. The sentence is what carries it —
              the marker only reinforces a word that already says everything,
              so the badge still works for a reader who sees no colour. */}
          <span
            className={`nb-tape ${insecure ? "nb-sem-urgent" : "nb-sem-done"}`}
          >
            {insecure
              ? "Not encrypted — anything typed into this page travels in the clear"
              : "Encrypted connection"}
          </span>
        </p>
        <p className="browser-reader-note">
          The text of the page as the assistant reads it. The page itself is a
          separate window layer this app cannot put into the reading order, so
          this is a copy — links here open in the browser beside it. Press
          Escape twice inside the page to bring the keyboard back here.
        </p>
        <div className="browser-reader-tools">
          <button
            className="browser-btn"
            type="button"
            aria-pressed={mode === "full"}
            onClick={() => setMode((m) => (m === "full" ? "main" : "full"))}
          >
            {mode === "full"
              ? "Main content only"
              : "Include navigation, headers and footers"}
          </button>
          <button
            className="browser-btn"
            type="button"
            disabled={busy}
            onClick={() => void load(mode)}
          >
            Re-read the page
          </button>
          <button
            className="browser-btn"
            type="button"
            onClick={onClose}
          >
            Close the reading view
          </button>
        </div>
      </header>

      {/* Every state below says which one it is. "Nothing here" must never be
          the same rendering as "we could not ask". */}
      <div className="browser-reader-body" ref={bodyRef}>
        {error && (
          <p className="browser-reader-error" role="alert">
            {error}
          </p>
        )}
        {!error && busy && !page && <p aria-live="polite">Reading the page…</p>}
        {!error && page && page.text.trim() === "" && (
          <p>
            This page returned no text. It may be a PDF, a canvas or a video —
            things the reader cannot turn into words.
          </p>
        )}
        {!error && page && page.text.trim() !== "" && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Links stay inside the private browser. `href` is already
              // absolute — the extractor resolves it against the page's base.
              a: ({ href, children }) =>
                href ? (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(href);
                    }}
                  >
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
            }}
          >
            {page.text}
          </ReactMarkdown>
        )}
        {page?.truncated && (
          <p className="browser-reader-more">
            {/* The count is the honest part: a reader that silently stopped at
                40 000 characters would present a slice as the whole page. */}
            <span>
              Showing the first {shown.toLocaleString()} of{" "}
              {page.total.toLocaleString()} characters.
            </span>{" "}
            <button className="browser-btn" type="button" disabled={busy} onClick={() => void more()}>
              Read the next part
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
