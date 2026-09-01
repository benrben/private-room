import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unzip, unzipSync } from "fflate";
import { api } from "../api";
import { Book, chapterHtml, parseEpub } from "./epub";
import { findEntry } from "./zipdoc";
import { frameIsDark, useFrameTheme } from "./frameTheme";
import { textOf } from "./htmlText";
import { useFileBytes } from "./useFileBytes";
import FoliateBookView from "./FoliateBookView";
import "./book.css";

const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.5];

type ReaderMode = "page" | "text";

interface EpubProps {
  mediaToken?: string | null;
  dataB64?: string | null;
}

interface BookViewProps extends EpubProps {
  name?: string;
}

function bookStatus(
  loading: boolean,
  readError: string,
  error: string,
  book: Book | null,
) {
  if (loading) return <div className="empty-hint">Opening book…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (error) return <div className="empty-hint">{error}</div>;
  if (!book) return <div className="empty-hint">Reading book…</div>;
  return null;
}

function BookReaderBar({
  book,
  chapter,
  at,
  tocOpen,
  mode,
  fontStep,
  onToggleToc,
  onMode,
  onFontStep,
}: {
  book: Book;
  chapter: Book["chapters"][number];
  at: number;
  tocOpen: boolean;
  mode: ReaderMode;
  fontStep: number;
  onToggleToc: () => void;
  onMode: (mode: ReaderMode) => void;
  onFontStep: (delta: number) => void;
}) {
  return (
    <div className="book-bar rdr-bar">
      <button className="nb-btn" onClick={onToggleToc} aria-expanded={tocOpen}>
        Contents
      </button>
      <span className="book-where" title={book.title}>
        {chapter.title}
        <span className="book-of">
          {" "}· {at + 1} of {book.chapters.length}
        </span>
      </span>
      <span className="rdr-modes" role="group" aria-label="How to read this chapter">
        <button
          type="button"
          className="rdr-mode"
          aria-pressed={mode === "page"}
          title="The chapter as the publisher set it"
          onClick={() => onMode("page")}
        >
          Page
        </button>
        <button
          type="button"
          className="rdr-mode"
          aria-pressed={mode === "text"}
          title="The chapter's words — selectable, and quotable in chat"
          onClick={() => onMode("text")}
        >
          Text
        </button>
      </span>
      <span className="book-actions">
        <button
          className="nb-btn nb-btn-icon"
          disabled={fontStep <= 0}
          title="Smaller text"
          onClick={() => onFontStep(-1)}
        >
          A−
        </button>
        <button
          className="nb-btn nb-btn-icon"
          disabled={fontStep >= FONT_STEPS.length - 1}
          title="Larger text"
          onClick={() => onFontStep(1)}
        >
          A+
        </button>
      </span>
    </div>
  );
}

function BookProgress({ at, last }: { at: number; last: number }) {
  const progress = last > 0 ? Math.round((at / last) * 100) : 100;
  return (
    <div
      className="rdr-progress book-progress"
      aria-hidden
      style={{ "--nb-val": `${progress}%` } as React.CSSProperties}
    >
      <i />
    </div>
  );
}

function BookToc({ book, at, onSelect }: { book: Book; at: number; onSelect: (index: number) => void }) {
  return (
    <nav className="book-toc" aria-label="Table of contents">
      {book.cover ? <img className="book-cover" src={book.cover} alt="" /> : null}
      <div className="book-meta">
        <strong>{book.title || "Untitled"}</strong>
        {book.author ? <span>{book.author}</span> : null}
      </div>
      <ol>
        {book.chapters.map((chapter, index) => (
          <li key={chapter.path}>
            <button className={index === at ? "active" : ""} onClick={() => onSelect(index)}>
              {chapter.title}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function BookText({ plain }: { plain: string }) {
  if (!plain) {
    return <div className="empty-hint">This chapter has no text of its own — it may be a full-page image or a plate.</div>;
  }
  return <pre className="html-doc" dir="auto">{plain}</pre>;
}

function BookPage({ url, title }: { url: string; title: string }) {
  if (!url) return <div className="empty-hint">Turning to {title}…</div>;
  return (
    <iframe
      key={url}
      className="book-frame"
      // No allow-scripts: a book is prose. The sandbox's CSP already forbids
      // script; withholding the permission too keeps the frame opaque.
      sandbox=""
      src={url}
      title={title}
    />
  );
}

function ChapterDisplay({ mode, plain, url, title }: { mode: ReaderMode; plain: string; url: string; title: string }) {
  if (mode === "text") return <div className="book-text"><BookText plain={plain} /></div>;
  return <BookPage url={url} title={title} />;
}

function BookNavigation({ at, last, onGo }: { at: number; last: number; onGo: (delta: number) => void }) {
  return (
    <div className="book-nav">
      <button className="nb-btn" disabled={at <= 0} onClick={() => onGo(-1)}>
        ‹ Previous
      </button>
      <button className="nb-btn" disabled={at >= last} onClick={() => onGo(1)}>
        Next ›
      </button>
    </div>
  );
}

function EpubReader({
  book,
  chapter,
  at,
  url,
  plain,
  tocOpen,
  mode,
  fontStep,
  onToggleToc,
  onMode,
  onFontStep,
  onSelect,
  onGo,
  onKeyDown,
}: {
  book: Book;
  chapter: Book["chapters"][number];
  at: number;
  url: string;
  plain: string;
  tocOpen: boolean;
  mode: ReaderMode;
  fontStep: number;
  onToggleToc: () => void;
  onMode: (mode: ReaderMode) => void;
  onFontStep: (delta: number) => void;
  onSelect: (index: number) => void;
  onGo: (delta: number) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const last = book.chapters.length - 1;
  return (
    <div className="book-view" onKeyDown={onKeyDown} tabIndex={-1}>
      <BookReaderBar
        book={book}
        chapter={chapter}
        at={at}
        tocOpen={tocOpen}
        mode={mode}
        fontStep={fontStep}
        onToggleToc={onToggleToc}
        onMode={onMode}
        onFontStep={onFontStep}
      />
      <BookProgress at={at} last={last} />
      <div className="book-stage">
        {tocOpen ? <BookToc book={book} at={at} onSelect={onSelect} /> : null}
        <ChapterDisplay mode={mode} plain={plain} url={url} title={chapter.title} />
      </div>
      <BookNavigation at={at} last={last} onGo={onGo} />
    </div>
  );
}

function isEpub(name: string) {
  return name.toLocaleLowerCase().endsWith(".epub");
}

interface ChapterStaging {
  files: Record<string, Uint8Array>;
  chapterPath: string;
  fontSize: number;
  alive: () => boolean;
  setUrl: (url: string) => void;
  setError: (error: string) => void;
}

async function stageChapter({
  files,
  chapterPath,
  fontSize,
  alive,
  setUrl,
  setError,
}: ChapterStaging) {
  try {
    const html = chapterHtml(files, chapterPath, fontSize, frameIsDark());
    const token = await api.stagePreviewHtml(html);
    if (alive()) setUrl(`roomdoc://localhost/${token}`);
  } catch (error) {
    if (alive()) setError(`This chapter could not be shown: ${String(error)}`);
  }
}

function chapterText(
  files: Record<string, Uint8Array> | null,
  chapter: Book["chapters"][number] | undefined,
) {
  if (!files || !chapter) return "";
  // The tolerant lookup every other reader of a chapter path uses: an OPF href
  // that differs only in case or a leading slash still has to be quotable.
  const raw = findEntry(files, chapter.path);
  if (!raw) return "";
  try {
    return textOf(new TextDecoder().decode(raw));
  } catch {
    return "";
  }
}

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
function EpubBookView({ mediaToken, dataB64 }: EpubProps) {
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
  // A chapter renders in an opaque frame, so a selection made inside it never
  // reaches the app and cannot be quoted. This is the same second reading the
  // page reader offers, and the only way a book's words can be pointed at.
  const [mode, setMode] = useState<ReaderMode>("page");

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    setError("");
    setBook(null);
    const open = (files: Record<string, Uint8Array>) => {
      if (!alive) return;
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
    };
    try {
      unzip(bytes, (err, files) => {
        if (!alive) return;
        if (err) {
          setError(`This book could not be read: ${err.message}`);
          return;
        }
        open(files);
      });
    } catch {
      // fflate hands any entry over 512 KB that also compresses well to a
      // Worker built from a `blob:` URL — which this app's CSP refuses, so the
      // constructor throws straight out of `unzip`, past the (err, files)
      // callback and out of this effect. A book with one long chapter took the
      // whole centre pane down to the chunk boundary. Inflate it here instead:
      // slower on the main thread, but it opens, and the callback cannot have
      // fired (fflate only calls it once every entry has landed).
      try {
        open(unzipSync(bytes));
      } catch (e) {
        setError(`This book could not be read: ${String(e)}`);
      }
    }
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
    void stageChapter({
      files,
      chapterPath: chapter.path,
      fontSize: FONT_STEPS[fontStep],
      alive: () => alive,
      setUrl,
      setError,
    });
    return () => {
      alive = false;
    };
    // `theme` belongs here because chapterHtml BAKES the palette in: without
    // it, switching the app to light left the chapter charcoal until the
    // reader changed page or font size.
  }, [book, at, fontStep, theme]);

  const plain = useMemo(
    () => (mode === "text" ? chapterText(filesRef.current, book?.chapters[at]) : ""),
    [mode, book, at],
  );

  const go = useCallback(
    (delta: number) => {
      if (!book) return;
      setAt((n) => Math.min(book.chapters.length - 1, Math.max(0, n + delta)));
      setTocOpen(false);
    },
    [book],
  );

  const selectChapter = useCallback((index: number) => {
    setAt(index);
    setTocOpen(false);
  }, []);

  const changeFontStep = useCallback((delta: number) => {
    setFontStep((step) => Math.min(FONT_STEPS.length - 1, Math.max(0, step + delta)));
  }, []);

  // Arrow keys turn the page, the way every reader does. Bound on the wrapper
  // rather than the window so it can't fight the rest of the app.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
    if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
  }

  const status = bookStatus(loading, readError, error, book);
  if (status || !book) return status;

  const chapter = book.chapters[at];
  return (
    <EpubReader
      book={book}
      chapter={chapter}
      at={at}
      url={url}
      plain={plain}
      tocOpen={tocOpen}
      mode={mode}
      fontStep={fontStep}
      onToggleToc={() => setTocOpen((open) => !open)}
      onMode={setMode}
      onFontStep={changeFontStep}
      onSelect={selectChapter}
      onGo={go}
      onKeyDown={onKeyDown}
    />
  );
}

function AlternativeBookView({ name, mediaToken, dataB64 }: Required<Pick<BookViewProps, "name">> & EpubProps) {
  const { bytes, error, loading } = useFileBytes(
    mediaToken,
    dataB64,
  );
  if (loading) return <div className="empty-hint">Opening book…</div>;
  if (error) return <div className="empty-hint">{error}</div>;
  if (!bytes) return <div className="empty-hint">Reading book…</div>;
  return <FoliateBookView name={name} bytes={bytes} />;
}

export default function BookView({ name = "book.epub", mediaToken, dataB64 }: BookViewProps) {
  if (isEpub(name)) return <EpubBookView mediaToken={mediaToken} dataB64={dataB64} />;
  return <AlternativeBookView name={name} mediaToken={mediaToken} dataB64={dataB64} />;
}
