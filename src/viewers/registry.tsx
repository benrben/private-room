import { lazy, type LazyExoticComponent, type ReactNode } from "react";
import { FileContent, ViewerKind } from "../api";
import type { RecordingLiveState } from "./RecordingView";
import EmailView from "./EmailView";
import HtmlView from "./HtmlView";
import ImageView from "./ImageView";
import JsonView from "./JsonView";
import LogView from "./LogView";
import MarkdownView from "./MarkdownView";
import OfficeDocView from "./OfficeDocView";
import ProseView from "./ProseView";
import QuickLookView from "./QuickLookView";
import SubtitleView from "./SubtitleView";
import SvgView from "./SvgView";
import TextView from "../workspace/TextView";
import { languageForFile } from "./languages";

/**
 * THE VIEWER REGISTRY — one row per file kind.
 *
 * The other half of `src-tauri/src/formats.rs`. Between them there is now
 * exactly ONE place per concern: Rust decides what a file IS (kind, where its
 * text comes from, whether it round-trips, how its bytes travel), and this
 * table decides what that kind LOOKS like and what its Edit button does.
 *
 * It replaces three hand-maintained lists that had to agree by eye — Rust's
 * `classify_file`, the frontend's `editModeOf`, and a 100-line `switch` in
 * ViewerRouter. `registry.test.mjs` asserts that every kind Rust can emit has
 * a row here, so adding a format on the Rust side fails the test suite instead
 * of silently landing on the "no preview available" card.
 */

// The heavy viewers load on demand so they stay out of the eager startup
// bundle: monaco-editor, pdfjs-dist, docx-preview, the SheetJS grid, the live
// recording editor, and the three that parse a zip container in the browser
// (slides, books, archives). All are default exports, so lazy() needs no
// remapping. They live in a rebuildable bundle (not module consts) because
// lazy() caches a rejected import forever — ViewerChunkBoundary's Retry swaps
// in fresh wrappers so the import actually re-runs.
export const makeLazyViewers = () => ({
  ArchiveView: lazy(() => import("./ArchiveView")),
  // Drags wavesurfer.js in with it, and nothing at startup plays audio.
  AudioView: lazy(() => import("./AudioView")),
  BookView: lazy(() => import("./BookView")),
  CodeEditor: lazy(() => import("./CodeEditor")),
  DocxView: lazy(() => import("./DocxView")),
  MarkdownEditor: lazy(() => import("./MarkdownEditor")),
  NotebookView: lazy(() => import("./NotebookView")),
  PdfView: lazy(() => import("./PdfView")),
  RecordingView: lazy(() => import("./RecordingView")),
  SheetView: lazy(() => import("./SheetView")),
  SlidesView: lazy(() => import("./SlidesView")),
});
export type LazyViewers = ReturnType<typeof makeLazyViewers>;

/** Where an agent or a search hit wants the viewer to land. */
export interface ViewTarget {
  page?: number;
  quote?: string;
  find?: string;
  sheet?: string;
  range?: string;
  cell?: string;
}

/** What the Edit button offers for a kind.
 *
 * `copy` is the honest name for the old behaviour on pdf/docx/text: it edits
 * the EXTRACTED text and saves a separate Markdown file. `docx` is the real
 * thing — an in-place rewrite of the Word file, which the agent could already
 * do and the user could not.
 */
export type EditMode = "grid" | "editor" | "copy" | "docx";

/** Everything a viewer row may need. Passing one context object (rather than
 * per-kind props) is what lets the table be a table. */
export interface ViewerContext {
  fileId: string;
  content: FileContent;
  target?: ViewTarget;
  /** Bumped to force a viewer to remount (a restore, an external write). */
  viewerRev: number;
  lazy: LazyViewers;
  editCell: (sheet: string, cell: string, value: string) => Promise<void>;
  /** Resolves false when the write failed. */
  saveEdit: (text: string) => Promise<boolean>;
  sttStatus?: Record<string, string>;
  recording: {
    live: RecordingLiveState | null;
    saveProgress: { stage: "transcribing" | "writing"; remaining: number } | null;
    pushToast: (
      kind: "info" | "success" | "error",
      text: string,
      action?: { label: string; run: () => void },
    ) => void;
    onStart: (
      fileId: string,
      opts: { systemAudio: boolean; liveTranslate: string | null },
    ) => Promise<void>;
    onPause: () => Promise<void>;
    onResume: () => Promise<void>;
    onStop: () => Promise<void>;
  };
}

export interface FormatEntry {
  /** Short human word for this kind, used in tooltips and empty states. */
  label: string;
  /** What Edit does here, given the file. `null` = the kind can't be edited. */
  edit: (c: FileContent) => EditMode | null;
  /** The preview. */
  render: (ctx: ViewerContext) => ReactNode;
}

/** Kinds whose text round-trips: Rust already decided per FILE (it also checks
 * the bytes are valid UTF-8), so the row only has to honour that answer. */
const editableText = (c: FileContent): EditMode | null => (c.editable ? "editor" : null);
/** Kinds with extracted-only text: editing produces a Markdown copy. */
const copyIfText = (c: FileContent): EditMode | null => (c.text ? "copy" : null);
const notEditable = (): EditMode | null => null;

/** A legacy `.xls`. The grid can READ one (calamine and SheetJS both do), but
 * `set_cell` writes an `.xlsx` workbook — which would silently change the
 * file's format while its name still said `.xls`. So it is read-only, and the
 * viewer says so rather than just omitting the button. */
const isLegacyXls = (name: string) => /\.xls$/i.test(name);

export const FORMATS: Record<ViewerKind, FormatEntry> = {
  // ---- rich formats: the viewer parses the streamed bytes ----------------
  image: {
    label: "picture",
    edit: notEditable,
    render: ({ fileId, content: c }) => (
      <ImageView
        fileId={fileId}
        name={c.name}
        mime={c.mime}
        mediaToken={c.mediaToken}
        dataB64={c.dataB64}
        // The OCR text rode in this payload but stopped here: it was searchable
        // and readable by the model, and invisible to the person who could tell
        // it was wrong.
        text={c.text}
      />
    ),
  },
  pdf: {
    label: "PDF",
    edit: copyIfText,
    render: ({ content: c, target: t, lazy }) => (
      <lazy.PdfView
        mediaToken={c.mediaToken}
        dataB64={c.dataB64}
        target={{ page: t?.page, quote: t?.quote ?? t?.find }}
      />
    ),
  },
  docx: {
    label: "Word document",
    // The ONE kind whose Edit is a real in-place rewrite rather than a copy.
    edit: (c) => (c.text ? "docx" : null),
    render: ({ content: c, target: t, lazy }) => (
      <lazy.DocxView
        mediaToken={c.mediaToken}
        dataB64={c.dataB64}
        target={{ quote: t?.quote ?? t?.find }}
      />
    ),
  },
  worddoc: {
    label: "document",
    // Edited as text like any other extracted-text document: the rewrite path
    // that writes back into the file is OOXML-only, and a legacy .doc has no
    // equivalent.
    edit: copyIfText,
    render: ({ fileId, content: c, target: t }) => (
      <OfficeDocView fileId={fileId} text={c.text} quote={t?.quote ?? t?.find} />
    ),
  },
  sheet: {
    label: "spreadsheet",
    // Legacy .xls can be READ by the grid but not written back through it —
    // set_cell writes an .xlsx workbook, which would silently change the file's
    // format under a name that still says .xls.
    edit: (c) => (isLegacyXls(c.name) ? null : "grid"),
    render: ({ content: c, target: t, lazy }) => (
      <lazy.SheetView
        mediaToken={c.mediaToken}
        dataB64={c.dataB64}
        target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
        readOnlyReason={
          isLegacyXls(c.name)
            ? "This is a legacy Excel 97–2003 file, which Arcelle can read but not write. Export it, save it as .xlsx, and add it back to edit it here."
            : undefined
        }
      />
    ),
  },
  csv: {
    label: "table",
    edit: () => "grid",
    render: ({ content: c, target: t, lazy }) => (
      <lazy.SheetView
        text={c.text}
        target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
      />
    ),
  },
  slides: {
    label: "presentation",
    edit: copyIfText,
    render: ({ fileId, content: c, target: t, lazy }) => (
      <lazy.SlidesView
        fileId={fileId}
        mediaToken={c.mediaToken}
        dataB64={c.dataB64}
        target={{ quote: t?.quote ?? t?.find }}
      />
    ),
  },
  book: {
    label: "book",
    edit: copyIfText,
    render: ({ content: c, lazy }) => (
      <lazy.BookView mediaToken={c.mediaToken} dataB64={c.dataB64} />
    ),
  },
  archive: {
    label: "archive",
    edit: notEditable,
    render: ({ content: c, lazy }) => (
      <lazy.ArchiveView mediaToken={c.mediaToken} dataB64={c.dataB64} />
    ),
  },

  // ---- raw text the viewer renders specially -----------------------------
  markdown: {
    label: "note",
    edit: editableText,
    render: ({ content: c, target: t }) => (
      <MarkdownView text={c.text ?? ""} target={{ quote: t?.quote ?? t?.find }} />
    ),
  },
  html: {
    label: "web page",
    edit: editableText,
    render: ({ content: c }) => <HtmlView source={c.text ?? ""} name={c.name} />,
  },
  svg: {
    label: "drawing",
    edit: editableText,
    render: ({ content: c }) => <SvgView text={c.text ?? ""} />,
  },
  notebook: {
    label: "notebook",
    edit: editableText,
    render: ({ content: c, lazy }) => <lazy.NotebookView text={c.text ?? ""} />,
  },
  json: {
    label: "data",
    edit: editableText,
    render: ({ content: c }) => <JsonView text={c.text ?? ""} name={c.name} />,
  },
  subtitle: {
    label: "subtitles",
    // Edited in the cue list itself rather than in a text editor — hand-editing
    // timecodes is the operation that actually breaks subtitle files.
    edit: notEditable,
    render: ({ content: c, saveEdit }) => (
      <SubtitleView
        text={c.text ?? ""}
        name={c.name}
        onSave={c.editable ? saveEdit : undefined}
      />
    ),
  },
  email: {
    label: "message",
    edit: notEditable,
    render: ({ content: c }) => <EmailView text={c.text ?? ""} />,
  },
  prose: {
    label: "text",
    edit: editableText,
    render: ({ content: c, target: t }) => (
      <ProseView text={c.text ?? ""} quote={t?.quote ?? t?.find} />
    ),
  },
  log: {
    label: "log",
    edit: editableText,
    render: ({ content: c }) => <LogView text={c.text ?? ""} />,
  },
  code: {
    label: "code",
    edit: editableText,
    // Read-only Monaco for the syntax colours; Edit unlocks the same editor.
    render: ({ fileId, content: c, target: t, viewerRev, lazy }) => (
      <lazy.CodeEditor
        key={`${fileId}-view-${viewerRev}`}
        value={c.text ?? ""}
        language={languageForFile(c.name)}
        readOnly
        find={t?.find}
      />
    ),
  },
  text: {
    label: "document",
    edit: copyIfText,
    // The catch-all: pptx text we couldn't lay out, RTF, legacy .doc/.ppt, an
    // oversized raw-text file. The words we DID read lead, and macOS draws the
    // page underneath — so a .doc shows both its text and what it looks like,
    // where before it showed a bare `<pre>` at best and nothing at worst.
    render: ({ fileId, content: c, target: t }) => (
      <QuickLookView fileId={fileId}>
        {c.text ? <TextView text={c.text} quote={t?.quote ?? t?.find} /> : null}
      </QuickLookView>
    ),
  },

  // ---- media --------------------------------------------------------------
  recording: {
    label: "recording",
    edit: notEditable,
    render: ({ fileId, content: c, recording, lazy }) => (
      <lazy.RecordingView
        fileId={fileId}
        mediaToken={c.mediaToken}
        live={recording.live}
        saveProgress={recording.saveProgress}
        pushToast={recording.pushToast}
        onStart={recording.onStart}
        onPause={recording.onPause}
        onResume={recording.onResume}
        onStop={recording.onStop}
      />
    ),
  },
  audio: {
    label: "audio",
    edit: notEditable,
    render: ({ fileId, content: c, target: t, sttStatus, lazy }) => (
      <lazy.AudioView
        kind="audio"
        fileId={fileId}
        mime={c.mime}
        dataB64={c.dataB64 ?? ""}
        mediaToken={c.mediaToken}
        text={c.text}
        target={{ quote: t?.quote ?? t?.find }}
        transcribing={sttStatus?.[c.name] === "processing"}
        sttStage={sttStatus?.[c.name]}
      />
    ),
  },
  video: {
    label: "video",
    edit: notEditable,
    render: ({ fileId, content: c, target: t, sttStatus, lazy }) => (
      <lazy.AudioView
        kind="video"
        fileId={fileId}
        mime={c.mime}
        dataB64={c.dataB64 ?? ""}
        mediaToken={c.mediaToken}
        mediaMeta={c.mediaMeta}
        text={c.text}
        target={{ quote: t?.quote ?? t?.find }}
        transcribing={sttStatus?.[c.name] === "processing"}
        sttStage={sttStatus?.[c.name]}
      />
    ),
  },

  // ---- nothing readable ---------------------------------------------------
  binary: {
    label: "file",
    edit: notEditable,
    // Nothing readable came out of the file — but the Mac may still know how
    // to draw it (.key, .pages, .numbers, RAW, PSD, a 3D model). QuickLook is
    // what turned "No preview available for this file type yet" from the end
    // of the line into the second-to-last step.
    render: ({ fileId }) => <QuickLookView fileId={fileId} />,
  },
};

/** What Edit means for the open file, if anything. The one answer the header
 * bar and the viewer both read — they used to derive it separately. */
export function editModeOf(c: FileContent): EditMode | null {
  return FORMATS[c.kind]?.edit(c) ?? null;
}

/** Every kind the table covers — the frontend half of the drift test. */
export function coveredKinds(): string[] {
  return Object.keys(FORMATS).sort();
}

export type { LazyExoticComponent };
