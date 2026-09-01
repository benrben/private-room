import type { MutableRefObject } from "react";

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

export function PdfFailurePanels({
  readError,
  readLoading,
  failed,
}: {
  readError: string | null;
  readLoading: boolean;
  failed: "damaged" | "locked" | null;
}) {
  if (failed === "locked") return <PdfLockedPanel />;
  if (failed === "damaged") return <PdfDamagedPanel />;
  if (readError) return <PdfReadError error={readError} />;
  return readLoading ? <div className="viewer-status">Opening document…</div> : null;
}

function PdfReadError({ error }: { error: string }) {
  return (
    <div className="pdf-failed" role="alert">
      <div className="pdf-failed-title">This PDF could not be read.</div>
      <p className="pdf-failed-body">{error}</p>
    </div>
  );
}

function PdfLockedPanel() {
  return (
    <div className="pdf-failed" role="alert">
      <div className="pdf-failed-title">This PDF is password-protected.</div>
      <p className="pdf-failed-body">
        It is encrypted, and this app can neither open it nor read its text — so it won't appear
        in search either. Unlock it in an app that can ask for the password and import the
        unlocked copy, or <strong>Export</strong> the original from the toolbar above. The file
        itself is stored here unchanged.
      </p>
    </div>
  );
}

function PdfDamagedPanel() {
  return (
    <div className="pdf-failed" role="alert">
      <div className="pdf-failed-title">This PDF could not be opened.</div>
      <p className="pdf-failed-body">
        The file may be incomplete or damaged. You can <strong>Export</strong> the original from
        the toolbar above to inspect it, replace it by importing the file again, or{" "}
        <strong>Close</strong> it.
      </p>
    </div>
  );
}

export function PdfProgress({
  failed,
  currentPage,
  totalPages,
}: {
  failed: "damaged" | "locked" | null;
  currentPage: number;
  totalPages: number;
}) {
  if (failed || totalPages === 0) return null;
  const percent = `${Math.round((currentPage / totalPages) * 100)}%`;
  return (
    <div
      className="rdr-progress pdf-progress"
      aria-hidden
      style={{ "--nb-val": percent } as React.CSSProperties}
    >
      <i />
    </div>
  );
}

type PdfToolbarProps = {
  failed: "damaged" | "locked" | null;
  scale: number;
  totalPages: number;
  currentPage: number;
  pageDraft: string;
  setPageDraft: (value: string) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
  goToPage: (page: number) => void;
  openFind: () => void;
};

export function PdfToolbar(props: PdfToolbarProps) {
  if (props.failed) return null;
  return (
    <div className="pdf-zoombar">
      <PdfZoomButtons {...props} />
      {props.totalPages > 0 && <PdfPageJump {...props} />}
      <button
        type="button"
        className="pdf-zoom-fit"
        onClick={props.openFind}
        title="Find in this document (⌘F)"
      >
        Find
      </button>
    </div>
  );
}

function PdfZoomButtons({ scale, zoomIn, zoomOut, fitWidth }: PdfToolbarProps) {
  return (
    <>
      <button
        type="button"
        className="pdf-zoom-btn"
        onClick={zoomOut}
        disabled={scale <= MIN_SCALE + 1e-9}
        title="Zoom out (⌘−)"
        aria-label="Zoom out"
      >
        −
      </button>
      <span className="pdf-zoom-pct">{Math.round(scale * 100)}%</span>
      <button
        type="button"
        className="pdf-zoom-btn"
        onClick={zoomIn}
        disabled={scale >= MAX_SCALE - 1e-9}
        title="Zoom in (⌘+)"
        aria-label="Zoom in"
      >
        +
      </button>
      <button type="button" className="pdf-zoom-fit" onClick={fitWidth} title="Fit width (⌘0)">
        Fit width
      </button>
    </>
  );
}

function pageDraftValue(draft: string, currentPage: number): string {
  return draft === "" ? String(currentPage) : draft;
}

function changePageDraft(value: string, setPageDraft: (value: string) => void) {
  setPageDraft(value.replace(/\D/g, ""));
}

function submitPageDraft(
  event: React.KeyboardEvent<HTMLInputElement>,
  draft: string,
  goToPage: (page: number) => void,
  clearDraft: () => void,
) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const page = parseInt(draft, 10);
  if (!Number.isNaN(page)) goToPage(page);
  clearDraft();
  event.currentTarget.blur();
}

function PdfPageJump({
  totalPages,
  currentPage,
  pageDraft,
  setPageDraft,
  goToPage,
}: PdfToolbarProps) {
  return (
    <label className="pdf-page-jump">
      Page
      <input
        type="text"
        inputMode="numeric"
        aria-label={`Page number, ${totalPages} pages in this document`}
        value={pageDraftValue(pageDraft, currentPage)}
        onChange={(event) => changePageDraft(event.target.value, setPageDraft)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setPageDraft("")}
        onKeyDown={(event) => submitPageDraft(event, pageDraft, goToPage, () => setPageDraft(""))}
      />
      <span className="pdf-page-total">of {totalPages}</span>
    </label>
  );
}

function matchingFindStatus(finding: boolean, hits: number[], at: number): string {
  if (finding && hits.length === 0) return "Searching…";
  if (hits.length === 0) return "No matches";
  return `Page ${hits[at]} · ${at + 1} of ${hits.length}${finding ? "…" : ""}`;
}

function findStatusMessage(query: string, finding: boolean, hits: number[], at: number): string {
  const needle = query.trim();
  if (!needle) return "";
  if (needle.length < 2) return "Keep typing…";
  return matchingFindStatus(finding, hits, at);
}

type PdfFindPanelProps = {
  failed: "damaged" | "locked" | null;
  open: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  query: string;
  finding: boolean;
  hits: number[];
  at: number;
  setQuery: (query: string) => void;
  closeFind: () => void;
  stepFind: (delta: number) => void;
  runFind: (query: string) => Promise<void>;
  findForRef: MutableRefObject<string>;
};

function handleFindInputKey(
  event: React.KeyboardEvent<HTMLInputElement>,
  props: PdfFindPanelProps,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    props.closeFind();
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (props.query.trim() && props.query.trim() === props.findForRef.current) {
    props.stepFind(event.shiftKey ? -1 : 1);
  } else {
    void props.runFind(props.query);
  }
}

export function PdfFindPanel(props: PdfFindPanelProps) {
  if (props.failed || !props.open) return null;
  return (
    <div className="pdf-findbar" role="search">
      <input
        ref={props.inputRef}
        type="text"
        className="pdf-find-input"
        dir="auto"
        placeholder="Find in this document"
        aria-label="Find in this document"
        value={props.query}
        onChange={(event) => props.setQuery(event.target.value)}
        onKeyDown={(event) => handleFindInputKey(event, props)}
      />
      <span className="pdf-find-count" role="status">
        {findStatusMessage(props.query, props.finding, props.hits, props.at)}
      </span>
      <button
        type="button"
        className="pdf-zoom-btn"
        onClick={() => props.stepFind(-1)}
        disabled={props.hits.length === 0}
        title="Previous match (⇧⏎)"
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        type="button"
        className="pdf-zoom-btn"
        onClick={() => props.stepFind(1)}
        disabled={props.hits.length === 0}
        title="Next match (⏎)"
        aria-label="Next match"
      >
        ↓
      </button>
      <button
        type="button"
        className="pdf-zoom-btn"
        onClick={props.closeFind}
        title="Close the find bar (Esc)"
        aria-label="Close the find bar"
      >
        ✕
      </button>
    </div>
  );
}

export function PdfScanStatus({
  scan,
  cancel,
}: {
  scan: { at: number; total: number } | null;
  cancel: () => void;
}) {
  if (!scan) return null;
  return (
    <div className="viewer-status pdf-scan" role="status">
      <span>
        Searching for the passage… page {scan.at + 1} of {scan.total}
      </span>
      <span className="pdf-scan-bar" aria-hidden>
        <i style={{ width: `${Math.round((scan.at / scan.total) * 100)}%` }} />
      </span>
      <button type="button" className="subtle" onClick={cancel}>
        Cancel
      </button>
    </div>
  );
}

export function PdfPages({
  containerRef,
  totalPages,
}: {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  totalPages: number;
}) {
  const label = totalPages > 0 ? `PDF document, ${totalPages} pages` : "PDF document";
  return <div ref={containerRef} className="pdf-pages" role="document" aria-label={label} />;
}
