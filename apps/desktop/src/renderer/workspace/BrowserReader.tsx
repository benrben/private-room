import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { BrowserInfo, BrowserPageText } from "../apiTypes";
import { useReadingProgress } from "../viewers/ProseView";
import { hostOf } from "./browserAnnounce";

type Mode = "main" | "full";

interface Loaded {
  text: string;
  title: string;
  url: string;
  next: number;
  total: number;
  truncated: boolean;
}

type ReaderState = {
  mode: Mode;
  page: Loaded | null;
  busy: boolean;
  error: string | null;
};

type ReaderActions = {
  reload: () => void;
  more: () => void;
  toggleMode: () => void;
};

function schemeOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

function isCurrent(runRef: React.MutableRefObject<number>, run: number) {
  return runRef.current === run;
}

function loadedPage(got: BrowserPageText): Loaded {
  return {
    text: got.text ?? "",
    title: got.title ?? "",
    url: got.url ?? "",
    next: got.nextOffset ?? 0,
    total: got.total ?? 0,
    truncated: got.truncated === true,
  };
}

function appendPage(page: Loaded | null, got: BrowserPageText): Loaded | null {
  if (page === null) return page;
  return {
    ...page,
    text: page.text + (got.text ?? ""),
    next: got.nextOffset ?? page.next,
    total: got.total ?? page.total,
    truncated: got.truncated === true,
  };
}

function pendingPage(page: Loaded | null): Loaded | null {
  if (!page || !page.truncated) return null;
  return page;
}

function startExtraction(setBusy: (busy: boolean) => void, onExtracting: (on: boolean) => void) {
  setBusy(true);
  onExtracting(true);
}

function finishExtraction(setBusy: (busy: boolean) => void, onExtracting: (on: boolean) => void) {
  setBusy(false);
  onExtracting(false);
}

function useReaderPage(
  url: string | null | undefined,
  onExtracting: (on: boolean) => void,
): [ReaderState, ReaderActions] {
  const [mode, setMode] = useState<Mode>("main");
  const [page, setPage] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(0);

  const load = useCallback(async (which: Mode) => {
    const run = ++runRef.current;
    setError(null);
    startExtraction(setBusy, onExtracting);
    try {
      const got = await api.browserPageText(which, 0);
      if (!isCurrent(runRef, run)) return;
      setPage(loadedPage(got));
    } catch (error) {
      if (!isCurrent(runRef, run)) return;
      setPage(null);
      setError(String(error));
    } finally {
      finishExtraction(setBusy, onExtracting);
    }
  }, [onExtracting]);

  const more = useCallback(async () => {
    const pending = pendingPage(page);
    if (!pending) return;
    const run = ++runRef.current;
    startExtraction(setBusy, onExtracting);
    try {
      const got = await api.browserPageText(mode, pending.next);
      if (!isCurrent(runRef, run)) return;
      setPage((current) => appendPage(current, got));
    } catch (error) {
      if (!isCurrent(runRef, run)) return;
      setError(String(error));
    } finally {
      finishExtraction(setBusy, onExtracting);
    }
  }, [mode, onExtracting, page]);

  useEffect(() => {
    void load(mode);
  }, [load, mode, url]);

  const toggleMode = () => {
    setMode((current) => (current === "full" ? "main" : "full"));
  };
  const reload = () => void load(mode);
  return [{ mode, page, busy, error }, { reload, more, toggleMode }];
}

function useReaderHeadingFocus(
  url: string | null | undefined,
  headingRef: React.RefObject<HTMLHeadingElement | null>,
) {
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [headingRef, url]);
}

function ReaderProgress({ read }: { read: number | null }) {
  if (read === null) return null;
  return (
    <div
      className="rdr-progress"
      aria-hidden
      style={{ "--nb-val": `${read}%` } as React.CSSProperties}
    >
      <i />
    </div>
  );
}

function ConnectionSecurity({ url }: { url: string | null | undefined }) {
  const scheme = schemeOf(url);
  if (scheme === "https:") {
    return <span className="nb-tape nb-sem-done">Encrypted connection</span>;
  }
  if (scheme !== "http:") return null;
  return (
    <span className="nb-tape nb-sem-urgent">
      Not encrypted — anything typed into this page travels in the clear
    </span>
  );
}

function ReaderAddress({ url }: { url: string | null | undefined }) {
  const location = hostOf(url) ?? url ?? "no address";
  const scheme = schemeOf(url);
  const showSecurity = scheme === "https:" || scheme === "http:";
  return (
    <p className="browser-reader-where">
      <span>{location}</span>
      {showSecurity && (
        <>
          <span className="sep">·</span>
          <ConnectionSecurity url={url} />
        </>
      )}
    </p>
  );
}

function ReaderInstruction({ comparing }: { comparing: boolean }) {
  const comparisonNote = comparing
    ? " The live page is beside it; press Escape twice inside that page to bring the keyboard back here."
    : " Escape closes this view.";
  return (
    <p className="browser-reader-note">
      The text of the page as the assistant reads it. The page itself is a
      separate window layer this app cannot put into the reading order, so
      this is a copy — links here open in the browser.{comparisonNote}
    </p>
  );
}

function StalePageNotice({
  page,
  infoUrl,
}: {
  page: Loaded | null;
  infoUrl: string | null | undefined;
}) {
  if (!page || page.url === "" || !infoUrl || page.url === infoUrl) return null;
  return (
    <p className="browser-reader-note" role="status">
      This text was taken from {page.url}, and the browser has since moved to
      {infoUrl}. Re-read the page to catch up.
    </p>
  );
}

function SurroundingContentToggle({
  mode,
  busy,
  onToggle,
}: {
  mode: Mode;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="browser-btn"
      type="button"
      disabled={busy}
      aria-pressed={mode === "full"}
      title="Include the parts around the article — menus, banners, footers"
      onClick={onToggle}
    >
      Navigation, headers and footers
    </button>
  );
}

function CompareButton({
  comparing,
  onCompare,
}: {
  comparing: boolean;
  onCompare: (on: boolean) => void;
}) {
  const label = comparing ? "Hide the live page" : "Compare with page";
  return (
    <button className="browser-btn" type="button" onClick={() => onCompare(!comparing)}>
      {label}
    </button>
  );
}

function ReaderTools({
  mode,
  busy,
  comparing,
  actions,
  onCompare,
  onClose,
}: {
  mode: Mode;
  busy: boolean;
  comparing: boolean;
  actions: Pick<ReaderActions, "reload" | "toggleMode">;
  onCompare: (on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="browser-reader-tools">
      <SurroundingContentToggle mode={mode} busy={busy} onToggle={actions.toggleMode} />
      <button className="browser-btn" type="button" disabled={busy} onClick={actions.reload}>
        Re-read the page
      </button>
      <CompareButton comparing={comparing} onCompare={onCompare} />
      <button className="browser-btn" type="button" onClick={onClose}>
        Close the reading view
      </button>
    </div>
  );
}

function ReaderHeader({
  info,
  page,
  mode,
  busy,
  comparing,
  headingRef,
  actions,
  onCompare,
  onClose,
}: {
  info: BrowserInfo;
  page: Loaded | null;
  mode: Mode;
  busy: boolean;
  comparing: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  actions: Pick<ReaderActions, "reload" | "toggleMode">;
  onCompare: (on: boolean) => void;
  onClose: () => void;
}) {
  const title = page?.title?.trim() || info.title || "This page has no title";
  const url = page?.url ?? info.url;
  return (
    <header className="browser-reader-head">
      <h1 ref={headingRef} tabIndex={-1} dir="auto">
        {title}
      </h1>
      <ReaderAddress url={url} />
      <ReaderInstruction comparing={comparing} />
      <StalePageNotice page={page} infoUrl={info.url} />
      <ReaderTools
        mode={mode}
        busy={busy}
        comparing={comparing}
        actions={actions}
        onCompare={onCompare}
        onClose={onClose}
      />
    </header>
  );
}

function ReaderError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="browser-reader-error" role="alert">{error}</p>;
}

function ReaderLoading({
  error,
  busy,
  page,
}: {
  error: string | null;
  busy: boolean;
  page: Loaded | null;
}) {
  if (error || !busy || page) return null;
  return <p aria-live="polite">Reading the page…</p>;
}

function ReaderEmptyPage({
  error,
  page,
}: {
  error: string | null;
  page: Loaded | null;
}) {
  if (error || !page || page.text.trim() !== "") return null;
  return (
    <p>
      This page returned no text. It may be a PDF, a canvas or a video —
      things the reader cannot turn into words.
    </p>
  );
}

function ReaderLink({
  href,
  children,
  onNavigate,
}: {
  href?: string;
  children: React.ReactNode;
  onNavigate: (url: string) => void;
}) {
  if (!href) return <span>{children}</span>;
  const followLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(href);
  };
  return <a href={href} onClick={followLink}>{children}</a>;
}

function ReaderMarkdown({
  error,
  page,
  onNavigate,
}: {
  error: string | null;
  page: Loaded | null;
  onNavigate: (url: string) => void;
}) {
  if (error || !page || page.text.trim() === "") return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <ReaderLink href={href} onNavigate={onNavigate}>{children}</ReaderLink>
        ),
      }}
    >
      {page.text}
    </ReactMarkdown>
  );
}

function ReaderMore({
  page,
  busy,
  onMore,
}: {
  page: Loaded | null;
  busy: boolean;
  onMore: () => void;
}) {
  if (!page?.truncated) return null;
  const shown = page.text.length;
  return (
    <p className="browser-reader-more">
      <span>
        Showing the first {shown.toLocaleString()} of {page.total.toLocaleString()} characters.
      </span>{" "}
      <button className="browser-btn" type="button" disabled={busy} onClick={onMore}>
        Read the next part
      </button>
    </p>
  );
}

function ReaderBody({
  bodyRef,
  error,
  busy,
  page,
  onNavigate,
  onMore,
}: {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  error: string | null;
  busy: boolean;
  page: Loaded | null;
  onNavigate: (url: string) => void;
  onMore: () => void;
}) {
  return (
    <div className="browser-reader-body" ref={bodyRef}>
      <ReaderError error={error} />
      <ReaderLoading error={error} busy={busy} page={page} />
      <ReaderEmptyPage error={error} page={page} />
      <ReaderMarkdown error={error} page={page} onNavigate={onNavigate} />
      <ReaderMore page={page} busy={busy} onMore={onMore} />
    </div>
  );
}

function closeOnEscape(onClose: () => void) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
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
  comparing: boolean;
  onCompare: (on: boolean) => void;
  onExtracting: (on: boolean) => void;
  onNavigate: (url: string) => void;
  onClose: () => void;
}) {
  const [state, actions] = useReaderPage(info.url, onExtracting);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const read = useReadingProgress(bodyRef);
  useReaderHeadingFocus(info.url, headingRef);
  return (
    <section
      className="browser-reader"
      aria-label="Page as text"
      onKeyDown={closeOnEscape(onClose)}
    >
      <ReaderProgress read={read} />
      <ReaderHeader
        info={info}
        page={state.page}
        mode={state.mode}
        busy={state.busy}
        comparing={comparing}
        headingRef={headingRef}
        actions={actions}
        onCompare={onCompare}
        onClose={onClose}
      />
      <ReaderBody
        bodyRef={bodyRef}
        error={state.error}
        busy={state.busy}
        page={state.page}
        onNavigate={onNavigate}
        onMore={actions.more}
      />
    </section>
  );
}
