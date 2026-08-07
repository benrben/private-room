import { useCallback, useEffect, useRef, useState } from "react";
import { unzip } from "fflate";
import { api } from "../api";
import { Book, chapterHtml, parseEpub } from "./epub";
import { frameIsDark, useFrameTheme } from "./frameTheme";
import { useFileBytes } from "./useFileBytes";
import "./book.css";

const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.5];

/**
 * An e-book, as a book.
 *
 * `.epub` had no viewer: the extractor concatenated every chapter and the file
 * opened on the plain-text card — a whole novel as one `<pre>`, with no
 * chapters, no table of contents and no typography.
 *
 * Chapters render inside the app's `roomdoc://` sandbox, the same isolated
 * origin the HTML runner uses: `default-src 'none'`, so the publisher's markup
 * and stylesheets display as written while script, network access and any
 * reach into the app or the room are impossible. Every asset is inlined as a
 * data URL before staging, which is what makes that CSP survivable.
 *
 * Built on fflate rather than on epub.js: that library is stale and pulls in
 * @xmldom/xmldom, which carries five unpatched high-severity XML-injection
 * advisories — not a dependency to add to an app whose whole point is opening
 * untrusted files safely.
 */
export default function BookView({
  mediaToken,
  dataB64,
}: {
  mediaToken?: string | null;
  dataB64?: string | null;
}) {
  const { bytes, error: readError, loading } = useFileBytes(mediaToken, dataB64);
  const filesRef = useRef<Record<string, Uint8Array> | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState("");
  const [at, setAt] = useState(0);
  const [url, setUrl] = useState("");
  // A staged chapter is an opaque origin and carries its palette in its own
  // markup, so a theme change means restaging — see the effect below.
  const theme = useFrameTheme();
  const [fontStep, setFontStep] = useState(1);
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    setError("");
    setBook(null);
    unzip(bytes, (err, files) => {
      if (!alive) return;
      if (err) {
        setError(`This book could not be read: ${err.message}`);
        return;
      }
      filesRef.current = files;
      try {
        const parsed = parseEpub(files);
        if (!parsed || parsed.chapters.length === 0) {
          setError("No chapters could be read from this book.");
          return;
        }
        setBook(parsed);
        setAt(0);
      } catch (e) {
        setError(`This book could not be read: ${String(e)}`);
      }
    });
    return () => {
      alive = false;
    };
  }, [bytes]);

  // Build and stage the current chapter. Staged per chapter rather than per
  // book so a 900-page volume doesn't build 900 documents to show one.
  useEffect(() => {
    const files = filesRef.current;
    const chapter = book?.chapters[at];
    if (!files || !chapter) return;
    let alive = true;
    setUrl("");
    (async () => {
      try {
        const html = chapterHtml(files, chapter.path, FONT_STEPS[fontStep], frameIsDark());
        const token = await api.stagePreviewHtml(html);
        if (alive) setUrl(`roomdoc://localhost/${token}`);
      } catch (e) {
        if (alive) setError(`This chapter could not be shown: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
    // `theme` belongs here because chapterHtml BAKES the palette in: without
    // it, switching the app to light left the chapter charcoal until the
    // reader changed page or font size.
  }, [book, at, fontStep, theme]);

  const go = useCallback(
    (delta: number) => {
      if (!book) return;
      setAt((n) => Math.min(book.chapters.length - 1, Math.max(0, n + delta)));
      setTocOpen(false);
    },
    [book],
  );

  // Arrow keys turn the page, the way every reader does. Bound on the wrapper
  // rather than the window so it can't fight the rest of the app.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
    if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
  }

  if (loading) return <div className="empty-hint">Opening book…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (error) return <div className="empty-hint">{error}</div>;
  if (!book) return <div className="empty-hint">Reading book…</div>;

  const chapter = book.chapters[at];
  const last = book.chapters.length - 1;

  return (
    <div className="book-view" onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="book-bar rdr-bar">
        <button className="nb-btn" onClick={() => setTocOpen((o) => !o)} aria-expanded={tocOpen}>
          Contents
        </button>
        <span className="book-where" title={book.title}>
          {chapter.title}
          <span className="book-of">
            {" "}
            · {at + 1} of {book.chapters.length}
          </span>
        </span>
        <span className="book-actions">
          <button
            className="nb-btn nb-btn-icon"
            disabled={fontStep <= 0}
            title="Smaller text"
            onClick={() => setFontStep((s) => Math.max(0, s - 1))}
          >
            A−
          </button>
          <button
            className="nb-btn nb-btn-icon"
            disabled={fontStep >= FONT_STEPS.length - 1}
            title="Larger text"
            onClick={() => setFontStep((s) => Math.min(FONT_STEPS.length - 1, s + 1))}
          >
            A+
          </button>
        </span>
      </div>
      {/* HOW FAR THROUGH THE BOOK, as a marker stroke.
          It tracks CHAPTERS, not the scroll inside one, and that is the honest
          limit rather than a shortcut: a chapter renders in a `roomdoc://`
          frame, which is an opaque origin — the app cannot read its scroll
          position and must not pretend to. The words beside it say "4 of 21",
          so the stroke never claims more precision than the sentence does.
          Decorative and aria-hidden for exactly that reason. */}
      <div
        className="rdr-progress book-progress"
        aria-hidden
        style={
          {
            "--nb-val": `${last > 0 ? Math.round((at / last) * 100) : 100}%`,
          } as React.CSSProperties
        }
      >
        <i />
      </div>
      <div className="book-stage">
        {tocOpen && (
          <nav className="book-toc" aria-label="Table of contents">
            {book.cover && <img className="book-cover" src={book.cover} alt="" />}
            <div className="book-meta">
              <strong>{book.title || "Untitled"}</strong>
              {book.author && <span>{book.author}</span>}
            </div>
            <ol>
              {book.chapters.map((c, i) => (
                <li key={c.path}>
                  <button
                    className={i === at ? "active" : ""}
                    onClick={() => {
                      setAt(i);
                      setTocOpen(false);
                    }}
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {url ? (
          <iframe
            key={url}
            className="book-frame"
            // No allow-scripts: a book is prose. The sandbox's CSP already
            // forbids script; withholding the permission too means the frame
            // is opaque even if a future CSP change slipped.
            sandbox=""
            src={url}
            title={chapter.title}
          />
        ) : (
          <div className="empty-hint">Turning to {chapter.title}…</div>
        )}
      </div>
      <div className="book-nav">
        <button className="nb-btn" disabled={at <= 0} onClick={() => go(-1)}>
          ‹ Previous
        </button>
        <button className="nb-btn" disabled={at >= last} onClick={() => go(1)}>
          Next ›
        </button>
      </div>
    </div>
  );
}
