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
 * IT NEVER COVERS THE STAGE — nothing in this window can, the page is drawn
 * above every DOM node. What it does instead changed (product audit P2,
 * 2026-08-15): it used to shrink the stage to a 320px sliver and keep it there
 * for the whole reading, so the workspace was permanently split between a
 * squeezed live page and a second copy of the same page. It now REPLACES the
 * page, and the split is a deliberate `Compare with page` rather than the
 * default.
 *
 * THE CONSTRAINT THAT MAKES THAT DELICATE, AND WHY THE SPLIT STILL EXISTS. A
 * WKWebView's layout viewport is its frame. At one pixel wide the page reflows
 * to tens of thousands of pixels tall and the extractor's own visibility rule
 * drops nearly all of it, so Rust refuses to read a parked page at all
 * (`too_small_to_read`). The page therefore needs a real viewport to be READ —
 * not to be LOOKED AT. `onExtracting` is that distinction made mechanical: the
 * host hands the stage back for the duration of an extraction and takes it away
 * again once the text is in hand. Rust's own settle loop (`BOUNDS_SETTLE`)
 * waits for the new bounds to arrive, which is what makes the handover safe.
 */

type Mode = "main" | "full";

/** The scheme of the address this text came from — `null` for a blank tab or an
 *  address that will not parse, exactly as the chrome above reads it. Three
 *  values, not two: "not http://" is not the same fact as "https://", and the
 *  reader used to print a green ENCRYPTED tape over an empty address. */
function schemeOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

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
  comparing,
  onCompare,
  onExtracting,
  onNavigate,
  onClose,
}: {
  info: BrowserInfo;
  /** The live page is being shown beside the text, because the user asked. */
  comparing: boolean;
  onCompare: (on: boolean) => void;
  /** An extraction is starting or has finished. The host gives the page a real
   *  layout viewport for exactly this window — see the note above. */
  onExtracting: (on: boolean) => void;
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
  /* Which extraction the panel is showing.
   *
   * An extraction is a full re-walk of the page's DOM and takes as long as the
   * page is big, so two can be in the air at once — press "Read the next part"
   * on a slow page and then follow a link in the text already rendered. The
   * `load` for the new page landed first and painted it; the older `more` then
   * resolved and APPENDED the previous document's next chunk underneath it,
   * with no seam and no warning. Every start claims the next number; an answer
   * whose number has been superseded is dropped rather than merged. */
  const runRef = useRef(0);

  const load = useCallback(
    async (which: Mode) => {
      const run = ++runRef.current;
      setBusy(true);
      setError(null);
      onExtracting(true);
      try {
        const got: BrowserPageText = await api.browserPageText(which, 0);
        if (runRef.current !== run) return;
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
        // that reads like an empty page. Still only for the extraction the
        // panel is showing — a refusal from a page we have already navigated
        // away from would blank the one that is there.
        if (runRef.current !== run) return;
        setPage(null);
        setError(String(e));
      } finally {
        setBusy(false);
        // In `finally`, not after the happy path: a refusal that left the page
        // holding the stage would leave the reader permanently beside a live
        // page it could not read.
        onExtracting(false);
      }
    },
    [onExtracting],
  );

  /** The next slice, appended.
   *
   * One press, one chunk — never a loop until `truncated` goes false. The page
   * script re-walks the whole DOM for every call, so a long document costs a
   * full extraction per chunk, and a page that rewrites itself between them
   * would tile two different documents together. Bounded and user-driven is
   * the honest shape. */
  const more = useCallback(async () => {
    if (!page || !page.truncated) return;
    const run = ++runRef.current;
    setBusy(true);
    onExtracting(true);
    try {
      const got: BrowserPageText = await api.browserPageText(mode, page.next);
      if (runRef.current !== run) return;
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
      if (runRef.current !== run) return;
      setError(String(e));
    } finally {
      setBusy(false);
      onExtracting(false);
    }
  }, [mode, page, onExtracting]);

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
  const scheme = schemeOf(page?.url ?? info.url);
  const secure = scheme === "https:";
  const insecure = scheme === "http:";
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
          {/* Whether the connection is encrypted is a STATE, so it is drawn as
              a strip of tape: red for urgent, green for verified, per the
              product-wide marker meanings. The sentence is what carries it —
              the marker only reinforces a word that already says everything,
              so the badge still works for a reader who sees no colour.
              Nothing is drawn for an address that is neither — a blank tab or
              a scheme this reader cannot vouch for gets no claim at all. */}
          {(secure || insecure) && (
            <>
              <span className="sep">·</span>
              <span
                className={`nb-tape ${insecure ? "nb-sem-urgent" : "nb-sem-done"}`}
              >
                {insecure
                  ? "Not encrypted — anything typed into this page travels in the clear"
                  : "Encrypted connection"}
              </span>
            </>
          )}
        </p>
        {/* The double-Escape chord is how you get the keyboard back OUT of the
            native page, so the instruction only belongs here while the page is
            actually on screen to be trapped in. Reading it beside a page that
            has been put away was an instruction with nothing to act on. */}
        <p className="browser-reader-note">
          The text of the page as the assistant reads it. The page itself is a
          separate window layer this app cannot put into the reading order, so
          this is a copy — links here open in the browser.
          {comparing
            ? " The live page is beside it; press Escape twice inside that page to bring the keyboard back here."
            : " Escape closes this view."}
        </p>
        {/* Stale relative to the live page, and says so. The text was
            extracted once; the page behind it may have moved on. */}
        {page && page.url !== "" && info.url && page.url !== info.url && (
          <p className="browser-reader-note" role="status">
            This text was taken from {page.url}, and the browser has since moved
            to {info.url}. Re-read the page to catch up.
          </p>
        )}
        <div className="browser-reader-tools">
          {/* `busy`, like its two neighbours. Without it, one click during a
              slow extraction started a SECOND one through the mode effect —
              two readers of the page's borrowed viewport, and the refcount in
              BrowserView exists precisely because they overlap. Gating it
              stops the overlap rather than only surviving it. */}
          {/* One fixed label naming what the toggle controls, with
              `aria-pressed` carrying the state — the shape "Read as text"
              already uses. Swapping the label as well announced the reverse
              of the truth: in full mode a screen reader read out "Main
              content only, pressed". The wiped-in `[aria-pressed="true"]`
              style is what shows the state to everyone else. */}
          <button
            className="browser-btn"
            type="button"
            disabled={busy}
            aria-pressed={mode === "full"}
            title="Include the parts around the article — menus, banners, footers"
            onClick={() => setMode((m) => (m === "full" ? "main" : "full"))}
          >
            Navigation, headers and footers
          </button>
          <button
            className="browser-btn"
            type="button"
            disabled={busy}
            onClick={() => void load(mode)}
          >
            Re-read the page
          </button>
          {/* The audit asked for the split to be an option rather than the
              default. This is that option. The label names the action the
              press will take, so there is no `aria-pressed`: the two together
              read as one sentence, and it was the wrong one — "Hide the live
              page, pressed" while the page was on screen. */}
          <button
            className="browser-btn"
            type="button"
            onClick={() => onCompare(!comparing)}
          >
            {comparing ? "Hide the live page" : "Compare with page"}
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
