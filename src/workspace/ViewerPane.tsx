import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { FileContent, RoomInfo, formatSize } from "../api";
import {
  BookOpenIcon,
  CloseIcon,
  CollapseLeftIcon,
  DotsIcon,
  DownloadIcon,
  EmptyViewerArt,
  EyeIcon,
  FocusIcon,
  LockIcon,
  MicIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ScriptIcon,
  SendIcon,
  SparkIcon,
  TimeMachineIcon,
} from "../icons";
import RoomMap from "../viewers/RoomMap";
import { displayName, fileLabel, formatWhen, provenanceLine } from "./composer";
import { libraryStatus } from "./fileVisibility";
import ViewerRouter from "./ViewerRouter";
import CloudView from "../viewers/CloudView";
import { frameSelectionOf } from "../viewers/frameSelection";
import { textOf } from "../viewers/htmlText";
import FrontPage from "./FrontPage";
import MemoryView from "./MemoryView";
import RecordingsPage from "./RecordingsPage";
import { useTextEncoding } from "../viewers/TextEncoding";
import {
  DocSourceCard,
  READER_KINDS,
  ReadingProgress,
  useReadingProgress,
} from "./ReaderShell";
import {
  inExcludedSurface,
  inQuotableDocument,
  quotableText,
  searchableDocument,
  verifiedFrameQuote,
  type SearchableDocument,
  withQuote,
} from "./quoteSelection";
import { isCloudRoute, isModelReady, trustState } from "./markup";
import ConnectorsView from "./ConnectorsView";
import { BrowserView } from "./BrowserView";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { FILE_BEARING_AREAS, WorkArea, isSketchFile } from "./types";
import { LayoutApi } from "../shell/useLayout";
import { WorkflowsPage } from "./workflows/WorkflowsPage";
import { WorkflowGlyph } from "./workflows/workflowGlyph";
import { ScriptsPage } from "./scripts/ScriptsPage";
import SkillsView from "./skills/SkillsView";
import { CreatePage } from "./create/CreatePage";
import { QuickActionsMenu, bindingMatches, QuickAction } from "./QuickActions";
import type { ViewerKind } from "../api";

/** Viewers that draw their own toolbar and manage their own scrolling, and so
 * need the full height of the pane rather than sizing to their content.
 *
 * This used to be spelled inline as `kind === "code" || kind === "html"`, which
 * was complete when those were the only two. Every viewer added since has a
 * bar across the top and a scroll region under it, and one that misses this
 * set collapses to content height with its toolbar floating above nothing.
 *
 * `fill` also drops `.viewer-body`'s page margin to zero, so a viewer only
 * belongs here if it draws its OWN padding — `.sk-tools` and `.rec-transport`
 * do. `.audio-view` and `.image-view` do not: adding them pins their controls
 * at the cost of running the player, the transcript and the OCR block flush
 * into the pane edges, and `.image-view`'s siblings would be clipped rather
 * than scrolled under `overflow: hidden`. Those two need padding in
 * composer.css/viewer-formats.css before they can join. */
const FILL_HEIGHT_KINDS = new Set<ViewerKind>([
  "archive",
  "book",
  "code",
  "html",
  "json",
  "log",
  "recording",
  "sheet",
  "csv",
  "sketch",
  "slides",
  "subtitle",
  "svg",
  "worddoc",
]);

/** Escape dismisses the popover, not the document behind it.
 *
 * Capture phase, because the shell's Escape handler (effects.ts) listens on
 * `window` in the BUBBLE phase and closes the open file: a menu that stopped
 * propagation only from its own subtree still lost the document underneath
 * it, leaving the popover drawn over whatever replaced it. Same dismissal
 * grammar as the top bar's shared menu slot. */
function useDismissOnEscape(
  open: boolean,
  close: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
}

/** True when a file name is a runnable script (.py/.js). */
function isScriptName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".py") || lower.endsWith(".js");
}

/** True when a media transcript carries real speech — at least one timestamped
 * "[m:ss] …" row with words. The "(transcribed from recording)" provenance line
 * and a lone silence "." don't count, so downstream actions (Minutes) don't
 * offer to summarize a recording that has nothing to summarize. */
function transcriptHasSpeech(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.split("\n").some((line) => {
    const m = line.match(/^\[(?:\d+:)?\d{1,2}:\d{2}\]\s*(.*)$/);
    return m ? /[\p{L}\p{N}]/u.test(m[1]) : false;
  });
}

/** A file's-worth of nothing, so `useTextEncoding` below — a hook, which has
 * to run on every render whether or not a file is open — always has a real
 * `FileContent` to ask rather than needing a nullable signature of its own.
 * `kind: "binary"` is never in `RE_DECODABLE_KINDS`, so with no file open
 * this resolves straight to the hook's idle state. */
const NO_FILE: FileContent = {
  kind: "binary",
  name: "",
  mime: "",
  editable: false,
  text: null,
  dataB64: null,
  mediaToken: null,
  mediaMeta: null,
  webMeta: null,
};

/** WHERE THIS OBJECT SHOWS UP, and the one control that changes it.
 *
 * Drawn only for objects that HAVE a placement to talk about — things made
 * inside a destination. An ordinary Library file returns `null` from
 * `libraryStatus` and gets no chip at all, because "In Library" stamped on
 * every document in the room is noise that makes the real signal invisible.
 *
 * Two states, two different jobs:
 *
 *   • section-only → a button. "Add to Library" is the whole affordance, and
 *     the confirmation says what will happen before it happens, because the
 *     word "Add" invites the reading "make a copy" and this makes none.
 *   • linked → a quiet status with a menu behind it. "View in Library" and
 *     "Remove from Library", where Remove is careful to say that it removes
 *     the Home reference and not the object — deleting is a different verb,
 *     with the trash behind it, and the two must never read as neighbours.
 */
function LibraryChip({
  s,
  a,
  fileId,
}: {
  s: WSState;
  a: WSActions;
  fileId: string;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  // Both popovers die with the file, like every other menu in this header.
  useEffect(() => {
    setOpen(false);
    setAsking(false);
  }, [fileId]);
  useDismissOnEscape(asking, setAsking);
  useDismissOnEscape(open, setOpen);
  const file = s.files.find((f) => f.id === fileId);
  const status = file ? libraryStatus(file) : null;
  if (!file || !status) return null;
  const label = displayName(file.name);

  if (!status.linked) {
    return (
      <span className="library-chip-wrap">
        <span className="library-chip" role="status">
          Section only
        </span>
        <button
          className="btn-ic library-chip-btn"
          aria-label={`Add ${label} to the Library`}
          aria-haspopup="dialog"
          aria-expanded={asking}
          onClick={() => setAsking((v) => !v)}
        >
          <BookOpenIcon size={12} /> Add to Library
        </button>
        {asking && (
          <>
            <div className="menu-backdrop" onMouseDown={() => setAsking(false)} />
            <div className="pop-menu library-chip-pop" role="dialog" aria-label="Add to Library">
              <p className="library-chip-q">
                <strong>Add to Library?</strong>
                <span>
                  “{label}” will also appear in Home. It stays in {status.where},
                  and this keeps one file — no duplicate.
                </span>
              </p>
              <div className="library-chip-actions">
                {/* The safe choice takes focus, so a dialog announced to a
                    screen reader does not then have to be hunted for by tab. */}
                <button className="subtle" autoFocus onClick={() => setAsking(false)}>
                  Cancel
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setAsking(false);
                    void a.setInLibrary(fileId, true);
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          </>
        )}
      </span>
    );
  }

  return (
    <span className="library-chip-wrap">
      <button
        className="library-chip is-linked"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`“${label}” is in the Library and in ${status.where}`}
        onClick={() => setOpen((v) => !v)}
      >
        <BookOpenIcon size={12} /> In Library
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="pop-menu library-chip-pop" role="menu" aria-label="Library placement">
            <button
              role="menuitem"
              className="pop-item"
              onClick={() => {
                setOpen(false);
                // "View in Library" is a navigation, not a second copy: the
                // object is already on screen, so this puts Home's list beside
                // it with the row selected.
                s.setShowMap(false);
                s.setShowScripts(false);
                s.setShowWorkflows(false);
                s.setArea("files");
                s.setLibraryTab("browse");
              }}
            >
              View in Library
            </button>
            <button
              role="menuitem"
              className="pop-item"
              title={`Stop showing this in Home. It stays in ${status.where} — this does not delete it.`}
              onClick={() => {
                setOpen(false);
                void a.setInLibrary(fileId, false);
              }}
            >
              <span className="pop-item-body">
                Remove from Library
                <span className="pop-item-sub">
                  Hides the Home entry — the object stays in {status.where}
                </span>
              </span>
            </button>
          </div>
        </>
      )}
    </span>
  );
}

/** The Sketch destination with nothing selected.
 *
 * Deliberately thin, and thinner than the gallery it replaces: the room's
 * sketches are listed in the contextual sidebar now, so repeating them here
 * would be the same navigation twice — the exact duplication the two-level IA
 * exists to remove. What the centre owes a reader who has just arrived is what
 * this place is for and how to start, and nothing else. */
function SketchLanding({ s, a }: { s: WSState; a: WSActions }) {
  const count = s.files.filter(isSketchFile).length;
  return (
    <div className="sk-empty" role="status">
      <p>{count === 0 ? "Nothing sketched yet" : "Pick a sketch to open it"}</p>
      <span>
        Drawings live in this room like any other file — versioned, searchable by
        their labels, and the room&rsquo;s AI can draw on them beside you. They
        stay in Sketches until you add one to the Library.
      </span>
      <button
        type="button"
        className="nb-btn nb-btn-primary"
        onClick={() => void a.createSketch()}
      >
        New sketch
      </button>
    </div>
  );
}

/** The center pane: a stable content header (breadcrumb + pane controls)
 * over the active surface — open file (any viewer), Workflows, Scripts,
 * Room Map, Memory, Recordings, the Front Page, or the sealed-room empty
 * state. An open file always wins, so citations and agent opens are never
 * swallowed by an area page; Escape returns to the area underneath. */
export default function ViewerPane({
  s,
  a,
  info,
  layout,
  area,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  /** The destination: which page draws when no file is open, where Escape
   * returns to when one is, and — since the two-level IA landed — the one
   * context every surface here describes. A document its destination does not
   * hold moves the app Home before it paints (see Workspace.tsx's
   * `showFileHere`), so there is no longer a second, disagreeing answer. */
  area: WorkArea;
}) {
  const { openFile } = s;
  // PRIV-1: the reader's "blocked version" toggle — resets per file.
  const [cloudView, setCloudView] = useState(false);
  useEffect(() => setCloudView(false), [openFile?.id]);
  // Which version's Delete is armed. Local, not a WSState slot: deleting a
  // version is the only History action with no undo, so the armed state must
  // die with the popover rather than survive a file switch.
  const [confirmDeleteVersion, setConfirmDeleteVersion] = useState<string | null>(
    null,
  );
  useEffect(() => setConfirmDeleteVersion(null), [openFile?.id, s.showHistory]);
  // P1-4: the "..." overflow popover (History, Copy all text, Duplicate,
  // Dictate, the cloud-payload preview, the encoding picker). Local, not a
  // WSState slot, for the same reason confirmDeleteVersion is — it belongs to
  // this popover's lifetime, not to the file, and must not survive a switch.
  const [overflowOpen, setOverflowOpen] = useState(false);
  useEffect(() => setOverflowOpen(false), [openFile?.id]);
  useDismissOnEscape(overflowOpen, setOverflowOpen);
  // The History popover outlives the menu that opened it (`openHistory` closes
  // the menu), so it is a third surface Escape used to shoot through — and the
  // one where doing so also took away the only route back to an earlier
  // version. Closed the same way its own toggle closes it.
  useDismissOnEscape(s.showHistory, s.setShowHistory);
  // "Preview cloud payload" only means something for a file that HAS text a
  // cloud model would be handed. Asking the kind was a proxy for that and went
  // stale every time a kind was added; ask the file itself.
  const cloudViewable = openFile != null && !!openFile.content.text;
  // P1-4: which of Edit/Run/Duplicate applies, computed once rather than
  // twice (the header used to ask `editModeOf` separately for the Edit
  // button and for Duplicate's own condition).
  const mode = openFile ? a.editModeOf(openFile.content) : null;

  // "Quote this in chat": selecting text is the most natural way a person
  // points at a passage, and until now the app dropped that gesture on the
  // floor — the reader had to retype or copy-paste what was already under
  // their cursor. Reading kinds only, never while editing, and never inside a
  // surface that owns its own selection (see quoteSelection.ts).
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(
    null,
  );
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setQuote(null);
        return;
      }
      // Both ends, not just the anchor — for the exclusion too. A drag that
      // started in the text and ended in the reader's own chrome was offered as
      // a quote, so a book's contents list or a mode button's label reached the
      // composer under the document's name; dragging the other way was refused,
      // which made the answer depend on the direction of the drag.
      if (
        !inQuotableDocument(sel.anchorNode) ||
        !inQuotableDocument(sel.focusNode) ||
        inExcludedSurface(sel.anchorNode) ||
        inExcludedSurface(sel.focusNode)
      ) {
        setQuote(null);
        return;
      }
      const text = quotableText(
        sel.toString(),
        openFile?.content.kind ?? null,
        s.editMode,
      );
      if (!text) {
        setQuote(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        setQuote(null);
        return;
      }
      setQuote({ text, top: r.top, left: r.left + r.width / 2 });
    };
    // selectionchange fires continuously during a drag; one read per frame.
    const onSel = () => {
      if (raf) return;
      raf = requestAnimationFrame(read);
    };
    // The coordinates come from a viewport-relative rect that nothing
    // recomputes on scroll, so the button would sit over an unrelated
    // paragraph the moment the reader moved. Dismissing rather than tracking
    // is the honest choice AND the cheaper one: a control that appears exactly
    // when it is wanted does not need to follow you around the page.
    // Capturing, because the document scrolls inside `.viewer-body`, not the
    // window, and scroll does not bubble.
    const clear = () => setQuote(null);
    document.addEventListener("selectionchange", onSel);
    document.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      document.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [openFile?.content.kind, s.editMode]);
  // A file swap leaves a stale button pinned over the new document.
  useEffect(() => setQuote(null), [openFile?.id]);

  // P1-4: lifted out of ViewerRouter, which used to own this hook entirely,
  // so the header's overflow menu can draw the same picker — see
  // TextEncoding.tsx. `enc` (not `encoding`) on purpose: ViewerRouter passes
  // it straight through to the editors' save banners under that exact name,
  // and `encoding.test.mjs` reads the literal `enc.decoded` text out of the
  // source to make sure every in-place editor still warns about a legacy
  // encoding being converted on save.
  const enc = useTextEncoding(openFile?.id ?? "", openFile?.content ?? NO_FILE);

  /* THE SAME GESTURE, FROM INSIDE A SANDBOXED FRAME.
     A saved page renders in an opaque `roomdoc://` frame, so the selection
     above cannot see it: `selectionchange` never fires on this document and
     `getSelection()` returns nothing. The frame reports its own selection
     instead (see frameSelection.ts) — which makes the text a claim by an
     untrusted document rather than something the app observed, so it is
     checked three ways before it can be quoted: the sender must be a frame
     inside the document being attributed to, that frame must be the one on
     screen, and the passage must actually occur in the file the app holds.

     The last check costs a page that BUILDS its text with script: the app has
     no copy of what that page generated, so it cannot vouch for it and does
     not offer it. Refusing to quote what cannot be verified is the point. */
  /* Parsed on FIRST REPORT and cached, never on open.
     Taking the document's text is a full parse of the page, and the reader it
     was lifted from is explicit that most pages are never read that way — so
     doing it eagerly here would charge every HTML file the cost of a feature
     it may never use. The cache is a ref rather than state because producing
     it must not re-render anything.

     Keyed on the TEXT as well as the file id, the way `useTextEncoding` keys on
     `{ id, payload }`. A page rewritten while it stays open (the editor, an
     agent write, a version restore) keeps its id, and a cache keyed on the id
     alone then verified every selection against the pre-edit page: a newly
     added sentence could not be quoted, and a deleted one still could, both
     without a word on screen. */
  const searchable = useRef<{
    id: string;
    text: string;
    doc: SearchableDocument;
  } | null>(null);
  /* The frame shows what the ENCODING PICKER produced, not what
     `get_file_content` decoded (ViewerRouter hands HtmlView `enc.text`). Once a
     detected charset is overruled, verifying against the original decode failed
     every selection holding a non-ASCII character — and never healed. */
  const shownFor = openFile?.id ?? null;
  const shownText = enc.text;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const report = frameSelectionOf(e.data);
      if (!report) return;
      const file = s.openFileRef.current;
      if (!file || file.content.kind !== "html") return;
      const frame = Array.from(document.querySelectorAll("iframe")).find(
        (f) => f.contentWindow === e.source,
      );
      // `hidden` matters: the reader keeps the frame mounted across mode
      // switches, and a stale selection inside an invisible page would put the
      // button over whatever is on screen instead.
      if (!frame || frame.hidden || !inQuotableDocument(frame)) return;
      const source =
        (shownFor === file.id ? shownText : null) ?? file.content.text ?? "";
      if (searchable.current?.id !== file.id || searchable.current.text !== source) {
        searchable.current = {
          id: file.id,
          text: source,
          doc: searchableDocument(textOf(source)),
        };
      }
      const text = verifiedFrameQuote(
        report.text,
        searchable.current.doc,
        file.content.kind,
        s.editMode,
      );
      if (!text || !report.rect) {
        setQuote(null);
        return;
      }
      // The frame reports its own viewport; the button lives in ours.
      const box = frame.getBoundingClientRect();
      setQuote({
        text,
        top: box.top + report.rect.top,
        left: box.left + report.rect.left + report.rect.width / 2,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [s.editMode, shownText, shownFor]);
  // §14, the research reader: a source card at the head of the column and a
  // reading-progress stroke over it. Reading formats only — see READER_KINDS —
  // and never over the cloud-payload preview, which is a diagnostic of what
  // WOULD be sent rather than a document to read.
  const readerShell =
    openFile != null &&
    !cloudView &&
    !s.editMode &&
    READER_KINDS.has(openFile.content.kind);
  // Keyed by file id, so opening the next document starts its own read.
  const reading = useReadingProgress(openFile?.id ?? "");
  // ProseView and PdfView already draw a progress stroke of their own
  // (`.rdr-progress`), so these two painted two strokes at the head of the
  // column — measured differently, and a PDF's page-count reading disagrees
  // with a scroll-offset one on a tall final page.
  const viewerDrawsProgress =
    openFile?.content.kind === "prose" || openFile?.content.kind === "pdf";
  // The privacy line on the empty room used to be a literal that read no
  // state. Same source as the status-bar chip under it, so the two can never
  // describe the same room differently.
  const trust = trustState(isCloudRoute(s.model, s.ai), s.privacyOn);
  // `trustState` answers from the engine route and the privacy door alone, so
  // its LOCAL sentence ends "nothing leaves the device" — false while online
  // search or a connector is on. The chip carries them (StatusBar), and this
  // line sits directly above it, so it has to carry them too.
  const alsoSendsOut = s.webOn || s.mcpTools.length > 0;
  // "Ask the room" cannot work before a model exists, and on a fresh Mac that
  // is a multi-gigabyte download nothing in the centre pane mentions. `s.ai`
  // still null means the probe hasn't answered yet, so this stays quiet then —
  // the same condition ChatPane's own setup banners wait on.
  const aiReady = s.ai == null || isModelReady(s.ai, s.model);
  const frontPageView =
    s.fp && (s.fp.fileCount > 0 || s.fp.chatCount > 0 || s.fp.memories.length > 0)
      ? s.fp
      : null;
  const AREA_CRUMBS: Record<WorkArea, string> = {
    files: "Files",
    home: "Home",
    map: "Room Map",
    recordings: "Recordings",
    workflows: "Workflows",
    scripts: "Scripts",
    skills: "Skills",
    memory: "Memory & scratch pad",
    connectors: "Connectors",
    create: "Create",
    sketch: "Sketch",
    browser: "Private browser",
  };
  const folderName = openFile
    ? s.folders.find(
        (fo) => fo.id === s.files.find((f) => f.id === openFile.id)?.folderId,
      )?.name
    : undefined;
  // "Describe new files automatically" (Settings > Behavior) — the cached
  // one-liner, when this file has one. P1-4 removed the viewer's own title
  // (the breadcrumb's crumb-title carries the name now), so this is the
  // subtitle line that sits under it; most files won't have one yet.
  const fileDescription = openFile
    ? s.files.find((f) => f.id === openFile.id)?.aiSummary
    : undefined;
  // The trail must name what is ON SCREEN. With nothing open the "files" area
  // renders the room's home page (or the sealed-room empty state), so saying
  // "Files" described a list the user wasn't looking at.
  const areaCrumb =
    area === "files" && !s.showWorkflows && !s.showScripts && !s.showMap
      ? "Home"
      : AREA_CRUMBS[area];
  // There is no "place underneath" any more, and that is the point. A document
  // used to be able to draw over a destination that did not hold it, with a
  // "back to Private browser" chip explaining the mismatch; the app now MOVES to
  // the destination that owns the document instead, so the rail, this trail and
  // the second column always name the same thing (see Workspace.tsx's
  // `showFileHere`). The chip is gone with the state it described.
  // BROWSE-1: the page is a NATIVE webview floating above everything this app
  // draws, so any modal, approval card or palette is invisible and unclickable
  // underneath it. Park the page (BrowserView shrinks it to 1×1) whenever one
  // of them is up — not just for the browse-consent card it was written for,
  // which left connector/edit/script approvals waiting behind the page forever.
  const overlayShowing =
    s.browseConsents.length > 0 ||
    s.mcpApprovals.length > 0 ||
    s.editApprovals.length > 0 ||
    s.scriptApprovals.length > 0 ||
    s.showSearch ||
    s.showSettings ||
    s.showShortcuts ||
    s.showFeedback ||
    s.showAddLink ||
    s.aiPrompt !== null ||
    s.studioPrompt !== null ||
    s.compare !== null ||
    s.ctxMenu !== null;
  return (
    <section className="viewer" aria-label="Workspace">
      {quote && openFile && (
        // Positioned over the selection, dismissed by the next selection
        // change. `onMouseDown` with preventDefault, not onClick: a click
        // would clear the selection before the handler could read it.
        <button
          className="quote-selection-btn"
          style={{ top: quote.top, left: quote.left }}
          onMouseDown={(e) => {
            e.preventDefault();
            s.setQuestion(withQuote(s.question, quote.text, openFile.content.name));
            setQuote(null);
            window.getSelection()?.removeAllRanges();
            // The Assistant is hidden in two of the layout presets, and a quote
            // landing in a box nobody can see is the same as no quote at all.
            layout.showPane("ai");
          }}
        >
          Quote in chat
        </button>
      )}
      {s.openingFileId && s.openingFileId !== openFile?.id && (
        // An overlay, not a branch in the ternary below. As a branch it did the
        // opposite of its job twice over: it never appeared in the common case
        // (opening a file while another is on screen, where `openFile` is still
        // set), and on a FAILED open it unmounted and remounted whatever area
        // page was showing — throwing away, for instance, a Create page's
        // half-written prompt. Nothing that reports a wait should be able to
        // destroy work.
        <div className="viewer-opening" role="status">
          Opening…
        </div>
      )}
      <div className="editor-breadcrumb-bar">
        <div className="editor-breadcrumb" title={openFile?.content.name}>
          <strong>{info.name}</strong>
          {" / "}
          {openFile ? (
            <>
              {/* Only a destination that CONTAINS this file may name itself
                  here — and since a document now always appears in the
                  destination that owns it, `area` IS that destination. The
                  file-bearing ones say so; Home says nothing, because "Home"
                  is not where a document lives, its folder is. */}
              {FILE_BEARING_AREAS.includes(area) ? `${AREA_CRUMBS[area]} / ` : ""}
              {folderName ? `${folderName} / ` : ""}
              <span className="crumb-title">
                {fileLabel(openFile.content.name, s.files)}
              </span>
            </>
          ) : (
            <span className="crumb-title">{areaCrumb}</span>
          )}
        </div>
        {/* THE PROMOTION AFFORDANCE, drawn once, for the object on screen.
            A section-only object offers "Add to Library"; a promoted one shows
            a quiet status with View and Remove behind it. An ordinary Library
            file gets neither — a badge on every one of a hundred documents is
            decoration, and the point of this chip is that it marks the
            exception (see fileVisibility.ts's `libraryStatus`). */}
        {openFile && <LibraryChip s={s} a={a} fileId={openFile.id} />}
        <div className="pane-actions">
          <button
            className="pane-icon-btn"
            data-tip="Focus this pane"
            aria-label="Give the workspace pane the full width"
            onClick={() => layout.toggleFocus("center")}
          >
            <FocusIcon size={14} />
          </button>
          <button
            className="pane-icon-btn"
            data-tip="Collapse"
            aria-label="Collapse the workspace pane"
            onClick={() => layout.collapsePane("center")}
          >
            <CollapseLeftIcon size={14} />
          </button>
        </div>
      </div>
      {/* The generated one-liner, when this file has one — see fileDescription
          above. Its own strip rather than something squeezed into the
          breadcrumb: the breadcrumb line is the room/folder TRAIL (P0-3) and
          already truncates hard on a narrow pane; this is the file's own
          content and deserves its own row, not a fight for the same pixels. */}
      {openFile && fileDescription && (
        <div className="viewer-file-description" title={fileDescription}>
          {fileDescription}
        </div>
      )}
      {openFile ? (
        <>
          <div className="viewer-head">
            {/* Renaming used to exist ONLY in the library's right-click menu,
                so the file you were actually looking at could not be renamed
                without hunting for its row. Same handler, same commit rules.
                P2-1: this used to sit beside a full-size title repeating the
                same filename the breadcrumb above it (and the tab above
                THAT) already carried, with the folder context, and the
                breadcrumb is the one place that actually earns its keep. No
                replacement title is drawn here — just the affordance that
                slot always had, now icon-only like Close beside it. */}
            {s.renamingFile?.id === openFile.id &&
            s.renamingFile.where === "viewer" ? (
              <input
                className="file-rename-input"
                autoFocus
                dir="auto"
                aria-label="Rename this file"
                value={s.renamingFile.name}
                onChange={(e) =>
                  s.setRenamingFile({
                    id: openFile.id,
                    name: e.target.value,
                    where: "viewer",
                  })
                }
                onBlur={a.commitRenameFile}
                onKeyDown={(e) => {
                  if (e.key === "Enter") a.commitRenameFile();
                  if (e.key === "Escape") s.setRenamingFile(null);
                }}
              />
            ) : (
              <button
                className="pane-icon-btn"
                data-tip="Rename"
                aria-label="Rename this file"
                onClick={() =>
                  // `where` keeps this box and the library row's box off the
                  // screen at the same time — they share one state slot, and
                  // two autoFocus inputs cancel each other on the first blur.
                  s.setRenamingFile({
                    id: openFile.id,
                    name: openFile.content.name,
                    where: "viewer",
                  })
                }
              >
                <PencilIcon size={14} />
              </button>
            )}
            <span className="viewer-actions">
              {/* P1-4: the file's own core verbs, given real button weight
                  (the plain button outline, not .subtle's quiet text) so
                  they read as the 2-3 things this toolbar is actually FOR.
                  Which ones apply is the same per-kind condition as before
                  (a script gets Edit+Run+Export, a recording with a
                  transcript gets Minutes+Export, most documents get
                  Edit+Export) — only the drawing changed, and where the
                  other six-to-eight items went: the overflow menu below. */}
              {!cloudView &&
                (() => {
                  if (!mode) return null;
                  const title =
                    mode === "copy"
                      ? "Edit the extracted text — saving creates a separate Markdown copy; the original file is unchanged"
                      : mode === "docx"
                        ? "Edit this document's text — saving writes it back into the Word file, keeping its styles and layout"
                        : "Switch between preview and editing";
                  return (
                    <button
                      className="btn-ic viewer-primary"
                      title={title}
                      onClick={() => s.setEditMode(!s.editMode)}
                    >
                      {s.editMode ? <EyeIcon size={14} /> : <PencilIcon size={14} />}
                      {s.editMode ? "Preview" : mode === "copy" ? "Edit as text" : "Edit"}
                    </button>
                  );
                })()}
              {/* Wave 5 (Idea 13): a .py/.js file runs from its own header —
                  outputs are saved back into the room, versioned + undoable. */}
              {isScriptName(openFile.content.name) &&
                (() => {
                  const sc = s.scripts.find((x) => x.fileId === openFile.id);
                  const running = !!(sc?.lastRun?.jobId && s.jobProgress[sc.lastRun.jobId]);
                  // The same rule the Scripts page's row follows: pressing this
                  // on an unapproved script CANNOT run it — `run_script_inner`
                  // refuses content whose hash is not approved on this Mac and
                  // raises the consent card instead. A button labelled "Run"
                  // promised execution that could not happen, which is what made
                  // the review gate read as broken. Unknown here (the script is
                  // not in `s.scripts` yet) is treated as unapproved: the label
                  // must never over-promise.
                  const approved = !!sc?.approved;
                  return (
                    <button
                      className="btn-ic viewer-primary"
                      title={
                        approved
                          ? "Run this script — outputs are saved into the room"
                          : "This version has not been approved — opens the review card; nothing runs until you approve it"
                      }
                      disabled={running}
                      onClick={() => {
                        if (s.editMode && s.editorDirtyRef.current) {
                          s.pushToast("info", "Save your edits first, then run the script.");
                          return;
                        }
                        void a.runScript(openFile.id);
                      }}
                    >
                      <PlayIcon size={14} /> {approved ? "Run" : "Review script"}
                    </button>
                  );
                })()}
              {(openFile.content.kind === "audio" ||
                openFile.content.kind === "video" ||
                openFile.content.kind === "recording") &&
                transcriptHasSpeech(openFile.content.text) && (
                  <button
                    className="btn-ic viewer-primary"
                    title="Turn this recording's transcript into timeline-style HTML minutes (summary, decisions, action items)"
                    disabled={s.asking}
                    onClick={a.makeMinutes}
                  >
                    <SparkIcon size={14} /> Minutes
                  </button>
                )}
              {(() => {
                // Wave 5 shortcuts: OTHER scripts whose declared inputs/outputs
                // name the open file. Used to show the first two as bare
                // icon-only play-glyph pills beside this menu — exactly the
                // unlabelled-control problem P1-4 is about — so now every
                // one of them, not just the overflow, lives behind the one
                // "Scripts" button.
                const name = openFile.content.name;
                const scriptActions: QuickAction[] = s.scripts
                  .filter(
                    (sc) =>
                      sc.fileId !== openFile.id &&
                      (sc.inputs.includes(name) || sc.outputs.includes(name)),
                  )
                  .map((sc) => ({
                    id: sc.fileId,
                    label: sc.name,
                    icon: <PlayIcon size={14} />,
                    hint: `Run ${sc.name}`,
                    onRun: () => void a.runScript(sc.fileId),
                  }));
                return (
                  <QuickActionsMenu
                    actions={scriptActions}
                    open={s.qaScriptMenuOpen ?? false}
                    onOpenChange={(o) => s.setQaScriptMenuOpen(o)}
                    buttonLabel="Scripts"
                    buttonIcon={<ScriptIcon size={14} />}
                  />
                );
              })()}
              {(() => {
                // Wave 4a shortcuts: file-scoped ACTIVE workflows matching this
                // file, run on the open file with one click.
                // A DRAWING'S TWO FLAT FORMATS, in the file header where every
                // other file-level act lives. They used to be a second Export
                // menu on the canvas toolbar, a few pixels under the header's
                // own Export — same word, different act, nothing saying which.
                // These write a new file INTO the room; the Export button
                // beside them writes a copy OUT of it, which is why they are
                // worded the way they are.
                const sketchActions: QuickAction[] = openFile.content.name.toLowerCase().endsWith(".sketch")
                  ? [
                      {
                        id: "sketch-png",
                        label: "Save a picture (PNG) in this room",
                        icon: <DownloadIcon size={14} />,
                        onRun: () => void a.exportSketchAs(openFile.id, "png"),
                      },
                      {
                        id: "sketch-svg",
                        label: "Save a drawing (SVG) in this room",
                        icon: <DownloadIcon size={14} />,
                        onRun: () => void a.exportSketchAs(openFile.id, "svg"),
                      },
                    ]
                  : [];
                const fileActions: QuickAction[] = s.workflows
                  .filter(
                    (w) =>
                      w.status === "active" &&
                      bindingMatches(
                        w.binding,
                        openFile.content.kind,
                        openFile.content.name,
                        openFile.id,
                      ),
                  )
                  .map((w) => ({
                    id: w.id,
                    label: w.name,
                    icon: <WorkflowGlyph emoji={w.emoji} size={14} />,
                    onRun: () =>
                      void a.runWorkflowOn(w.id, openFile.id, openFile.content.name),
                  }));
                return (
                  <QuickActionsMenu
                    actions={[...sketchActions, ...fileActions]}
                    open={s.qaFileMenuOpen ?? false}
                    onOpenChange={(o) => s.setQaFileMenuOpen(o)}
                    buttonLabel="Actions"
                    buttonIcon={<SparkIcon size={14} />}
                  />
                );
              })()}
              <button
                className="btn-ic viewer-primary"
                title="Export a normal copy out of the room"
                data-agent-blocked
                onClick={() => a.exportOne(openFile.id, openFile.content.name)}
              >
                <DownloadIcon size={14} /> Export
              </button>
              {/* P1-4: everything else — the cloud-payload preview, Duplicate,
                  Copy all text, Dictate, History and the encoding picker that
                  used to be its own strip over the document — collapsed into
                  one popover instead of an eight-wide flat row that clipped
                  on an HTML file. `viewer-overflow-wrap` also anchors the
                  History popover, which used to hang off the History button
                  itself and now hangs off this one instead — same corner of
                  the toolbar, same `history-pop`, untouched inside. */}
              <span className="viewer-overflow-wrap">
                <button
                  className={`subtle btn-ic${cloudView || s.showHistory ? " cloudview-on" : ""}`}
                  title="More actions"
                  aria-label="More actions on this file"
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                  onClick={() => setOverflowOpen((o) => !o)}
                >
                  <DotsIcon size={14} />
                </button>
                {overflowOpen && (
                  <>
                    <div
                      className="menu-backdrop"
                      onMouseDown={() => setOverflowOpen(false)}
                    />
                    <div
                      className="pop-menu viewer-overflow-menu"
                      role="menu"
                      aria-label="More actions on this file"
                    >
                      {cloudViewable && (
                        <button
                          role="menuitem"
                          className="pop-item"
                          onClick={() => {
                            setCloudView(!cloudView);
                            setOverflowOpen(false);
                          }}
                        >
                          {cloudView
                            ? "Close preview"
                            : "Show me exactly what would be sent"}
                        </button>
                      )}
                      {mode === "editor" && (
                        <button
                          role="menuitem"
                          className="pop-item"
                          title="Make a second copy of this file in the room, so you can branch it"
                          onClick={() => {
                            setOverflowOpen(false);
                            void a.duplicateOpenFile();
                          }}
                        >
                          <PlusIcon size={14} /> Duplicate
                        </button>
                      )}
                      {openFile.content.text && (
                        <button
                          role="menuitem"
                          className="pop-item"
                          title="Copy the whole document's extracted text"
                          onClick={() => {
                            setOverflowOpen(false);
                            a.copyAllText();
                          }}
                        >
                          Copy all text
                        </button>
                      )}
                      {openFile.content.editable && (
                        <button
                          role="menuitem"
                          className={`pop-item mic-btn ${a.micState("file").cls}`}
                          title={
                            s.dictOwner === "file" && s.dictState === "recording"
                              ? "Stop and append the words"
                              : "Dictate into this file — your words are appended to its saved content"
                          }
                          disabled={a.micState("file").disabled}
                          // Deliberately does NOT close the menu — Dictate is
                          // a start/stop toggle, and this row's recording dot
                          // is the only way to see (or stop) it once started.
                          onClick={a.dictateIntoFile}
                        >
                          <MicIcon size={12} /> Dictate
                        </button>
                      )}
                      <button
                        role="menuitem"
                        className={`pop-item ${s.showHistory ? "active" : ""}`}
                        onClick={() => {
                          setOverflowOpen(false);
                          a.openHistory();
                        }}
                      >
                        <TimeMachineIcon size={14} /> History
                      </button>
                      {/* The encoding picker never shows here while editing:
                          picking a different encoding re-reads the file's raw
                          bytes and remounts the editor with that new text (see
                          TextEncoding.tsx), which would silently throw away
                          whatever is typed but unsaved. Preview-only, same as
                          the strip this replaced. */}
                      {!s.editMode && enc.picker && (
                        <>
                          <div className="pop-menu-sep" />
                          <div className="viewer-enc-row">{enc.picker}</div>
                        </>
                      )}
                    </div>
                  </>
                )}
                {s.showHistory && (
                  <div className="history-pop">
                    {/* ART-1: what made the state on screen right now. Only
                        rendered when the room actually recorded it — see
                        `provenanceLine`, which returns "" otherwise. */}
                    {provenanceLine(s.headProvenance) && (
                      <div className="tm-now">
                        <span className="tm-now-label">Now</span>
                        <span className="tm-prov">
                          {provenanceLine(s.headProvenance)}
                        </span>
                      </div>
                    )}
                    {s.versions.length === 0 ? (
                      <div className="history-empty">
                        No earlier versions yet.
                      </div>
                    ) : (
                      <div className="time-machine">
                        {s.versions.map((v) =>
                          confirmDeleteVersion === v.id ? (
                            // No undo behind this one: there is no history of
                            // the history. Agent-blocked like every other armed
                            // destructive confirm (ADD-25).
                            <div key={v.id} className="tm-confirm" data-agent-blocked>
                              <span className="tm-confirm-q">
                                Delete this saved version? It cannot be brought
                                back.
                              </span>
                              <div className="tm-confirm-actions">
                                <button
                                  className="primary"
                                  onClick={() => {
                                    setConfirmDeleteVersion(null);
                                    void a.deleteVersion(v.id);
                                  }}
                                >
                                  Delete
                                </button>
                                <button
                                  className="subtle"
                                  onClick={() => setConfirmDeleteVersion(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : s.confirmRestore === v.id ? (
                            // ADD-25: the agent driver must not be able to
                            // confirm a restore it didn't earn.
                            <div key={v.id} className="tm-confirm" data-agent-blocked>
                              <span className="tm-confirm-q">
                                Restore this version? Current changes will be
                                replaced.
                              </span>
                              <div className="tm-confirm-actions">
                                <button
                                  className="primary"
                                  onClick={() => {
                                    s.setConfirmRestore(null);
                                    void a.restoreVersion(v.id);
                                  }}
                                >
                                  Restore
                                </button>
                                <button
                                  className="subtle"
                                  onClick={() => s.setConfirmRestore(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            // Idea 11: the row is no longer one restore button —
                            // it offers a read-only Compare (safe for the agent)
                            // and an armed Restore (still data-agent-blocked).
                            <div key={v.id} className="tm-version">
                              <span className="tm-version-dot" />
                              <span className="tm-cause">
                                {v.cause}
                                {v.pinned && (
                                  <span className="tm-kept" title="Kept — this version is never dropped to make room">
                                    Kept
                                  </span>
                                )}
                                {provenanceLine(v.provenance) && (
                                  <span className="tm-prov">
                                    {provenanceLine(v.provenance)}
                                  </span>
                                )}
                              </span>
                              <span className="tm-time">
                                {formatWhen(v.savedAt)}
                                {v.bytes > 0 && (
                                  <span className="tm-size">
                                    {" · "}
                                    {formatSize(v.bytes)}
                                  </span>
                                )}
                              </span>
                              <span className="tm-actions">
                                <button
                                  className="subtle tm-action"
                                  title="See what changed, side by side"
                                  onClick={() => void a.openCompare(v)}
                                >
                                  Compare
                                </button>
                                <button
                                  className="subtle tm-action"
                                  title={
                                    v.pinned
                                      ? "Stop keeping this version — it can be dropped again once there are newer ones"
                                      : "Keep this version — it is never dropped to make room for newer ones"
                                  }
                                  onClick={() => void a.pinVersion(v.id, !v.pinned)}
                                >
                                  {v.pinned ? "Unkeep" : "Keep"}
                                </button>
                                <button
                                  className="subtle tm-action"
                                  title="Restore this saved version"
                                  onClick={() => s.setConfirmRestore(v.id)}
                                >
                                  Restore
                                </button>
                                {/* Deleting a version is not itself undoable —
                                    there is no history of the history — so it
                                    arms, like Restore does. */}
                                <button
                                  className="subtle tm-action"
                                  title="Delete this saved version and free its space"
                                  data-agent-blocked
                                  onClick={() => setConfirmDeleteVersion(v.id)}
                                >
                                  Delete
                                </button>
                              </span>
                            </div>
                          ),
                        )}
                        {/* The rolling window used to be invisible: the
                            eleventh save silently dropped the oldest version
                            and nothing on screen had ever mentioned a limit.
                            State it, with what history costs and how to opt a
                            version out of it. */}
                        <div className="tm-retention">
                          {`Only the ${s.versionsKept} most recent versions are kept — press Keep to hold on to one.`}
                          {(() => {
                            const total = s.versions.reduce(
                              (n, v) => n + (v.bytes || 0),
                              0,
                            );
                            return total > 0
                              ? ` This file's history uses ${formatSize(total)}.`
                              : "";
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </span>
              {/* Live QA: typing in a .pptx or .docx and pressing Close threw
                  the buffer away and returned to Home, with no dialog and no
                  undo. Every other exit asked; this one didn't. */}
              <button
                className="pane-icon-btn"
                data-tip="Close"
                aria-label="Close this file"
                onClick={() =>
                  a.guardLeave("Closing this file", () => s.setOpenFile(null))
                }
              >
                <CloseIcon size={12} />
              </button>
            </span>
          </div>
          {/* Wave 1b (idea 10): the AI wrote this file while the user's editor
              buffer was dirty — the reload was skipped, the user chooses. Both
              paths are safe: every overwrite snapshots to History first. */}
          {s.staleFile === openFile.id && (
            <div className="stale-banner" role="status">
              <span className="stale-banner-text">
                The AI changed this file while you were editing.
              </span>
              <span className="stale-banner-actions">
                <button
                  className="primary"
                  title="Show the AI's version (your unsaved edits are discarded)"
                  onClick={() => {
                    s.setStaleFile(null);
                    s.editorDirtyRef.current = false;
                    void a.viewFile(openFile.id);
                  }}
                >
                  Load AI version
                </button>
                <button
                  className="subtle"
                  title="Keep your buffer — your next ⌘S overwrites; the AI's version stays in History"
                  onClick={() => s.setStaleFile(null)}
                >
                  Keep editing
                </button>
              </span>
            </div>
          )}
          {/* §14: how far down the document the reader has come, drawn as a
              marker stroke across the head of the column. Outside the scroller
              so it stays put while the page moves under it. */}
          {readerShell && !viewerDrawsProgress && (
            <ReadingProgress value={reading.progress} />
          )}
          <div
            // `fill` = this viewer manages its own scrolling and wants the
            // full height. Naming the two kinds that did was fine when there
            // were two; every viewer with its own toolbar and scroll region
            // needs it, and one that doesn't get it collapses to content
            // height with its toolbar floating above nothing.
            className={`viewer-body ${
              // The cloud-payload preview asks for the full height itself
              // (`.cloudview`), and it is not the file's kind that decides
              // that — it is not showing the file.
              cloudView ||
              FILL_HEIGHT_KINDS.has(openFile.content.kind) ||
              (s.editMode && a.editModeOf(openFile.content) !== "grid")
                ? "fill"
                : ""
            }${readerShell ? " is-reader" : ""}`}
            ref={readerShell ? reading.ref : undefined}
          >
            {/* The room's own record of the document, at the head of its
                column. Stands down for a saved web page: ViewerRouter draws
                PageSource for those, and the page's own declarations are the
                better witness. */}
            {readerShell && !openFile.content.webMeta && (
              <DocSourceCard file={s.files.find((f) => f.id === openFile.id)} />
            )}
            {cloudView ? (
              <CloudView fileId={openFile.id} />
            ) : (
            <ViewerRouter
              openFile={openFile}
              viewerRev={s.viewerRev}
              editMode={s.editMode}
              editModeOf={a.editModeOf}
              enc={enc}
              editCell={a.editCell}
              saveEdit={a.saveEdit}
              saveEditAsCopy={a.saveEditAsCopy}
              onDirtyChange={(d) => {
                s.editorDirtyRef.current = d;
              }}
              // Lets the unsaved-edits dialog's "Save" write the buffer that is
              // about to be unmounted — only the editor holds that text.
              registerSave={(fn) => {
                s.editorSaveRef.current = fn;
              }}
              recording={{
                live: s.recLive,
                saveProgress: s.recSave,
                pushToast: s.pushToast,
                onStart: a.startLiveRecording,
                onPause: a.pauseLiveRecording,
                onResume: a.resumeLiveRecording,
                onStop: a.stopLiveRecording,
              }}
              sttStatus={s.sttStatus}
            />
            )}
          </div>
        </>
      ) : s.showWorkflows ? (
        <WorkflowsPage s={s} a={a} />
      ) : s.showScripts ? (
        <ScriptsPage s={s} a={a} />
      ) : s.showMap ? (
        <div className="room-map-canvas">
          <RoomMap onOpenFile={(id) => a.viewFile(id)} />
        </div>
      ) : area === "browser" ? (
        <BrowserView
          parked={overlayShowing}
          // BROWSE-3: ＋ on a result imports it AND pins it to the composer, so
          // the page's text is in the very next turn rather than only findable
          // by a later search.
          onAttach={(file) => a.toggleAttach(file)}
          onAsk={(query) => {
            // Appended, never overwritten: the app already decided a
            // half-written draft is not a quote button's to throw away
            // (`withQuote`), and this is the same gesture from the results
            // page. And shown, because the Assistant is hidden in two of the
            // layout presets — a question landing in a box nobody can see is
            // the same as no question at all.
            const draft = s.question.trim();
            s.setQuestion(draft ? `${draft}\n\n${query}` : query);
            layout.showPane("ai");
          }}
        />
      ) : area === "connectors" ? (
        <ConnectorsView />
      ) : area === "skills" ? (
        <SkillsView s={s} a={a} info={info} />
      ) : area === "memory" ? (
        <MemoryView s={s} a={a} info={info} />
      ) : area === "recordings" ? (
        <RecordingsPage s={s} a={a} info={info} />
      ) : area === "create" ? (
        <CreatePage s={s} a={a} />
      ) : area === "sketch" ? (
        // The gallery's LIST moved to the contextual sidebar, where it stays
        // beside the canvas instead of vanishing the moment a drawing opens.
        // What is left in the centre is the landing: what this destination is
        // for, and the one way to start.
        <SketchLanding s={s} a={a} />
      ) : frontPageView ? (
        <FrontPage page={frontPageView} s={s} a={a} layout={layout} info={info} />
      ) : (
        <div className="viewer-empty">
          <div className="viewer-empty-icon">
            <EmptyViewerArt />
          </div>
          <h1 className="viewer-empty-title">Your room is sealed</h1>
          <p className="viewer-empty-sub">
            Everything you add stays inside{" "}
            <strong>{info.path.split("/").pop()}</strong>.{" "}
            {aiReady
              ? "Add a file, open a note, or ask the room a question about everything inside."
              : "Add a file to get started — asking the room a question needs a model, and this room's AI isn't set up yet."}
          </p>
          <div className="viewer-empty-actions">
            <button className="qa-btn primary" onClick={a.importFiles}>
              <PlusIcon size={14} /> Add a file
            </button>
            {aiReady ? (
              <>
                {/* Not drawn on an empty room. It was permanently greyed on
                    the first screen a person ever sees, with the reason
                    sealed inside a title a disabled button cannot show. */}
                {s.files.length > 0 && (
                  <button
                    className="qa-btn"
                    disabled={
                      s.summaryStarting ||
                      s.jobs.some(
                        (j) => j.status === "running" || j.status === "queued",
                      )
                    }
                    onClick={() => void a.startDeepSummary()}
                  >
                    <SparkIcon size={14} /> Summarize room
                  </button>
                )}
                <button
                  className="qa-btn"
                  onClick={() => a.focusComposer(layout)}
                >
                  <SendIcon size={14} /> Ask the room
                </button>
              </>
            ) : (
              <button
                className="qa-btn"
                onClick={() => a.focusComposer(layout)}
              >
                <SparkIcon size={14} /> Set up the AI
              </button>
            )}
          </div>
          <div className="viewer-empty-note">
            <LockIcon size={16} />
            <div>
              <strong>This room is an encrypted file on this Mac.</strong>{" "}
              {trust.tone === "good" && alsoSendsOut
                ? "The AI runs on this Mac — but online search or a connected tool sends what it asks for off the device."
                : trust.title}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
