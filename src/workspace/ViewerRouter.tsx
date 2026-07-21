import { Component, lazy, Suspense, type ReactNode } from "react";
import { FileContent } from "../api";
import { OpenFile } from "./types";
import AudioView from "../viewers/AudioView";
import type { RecordingLiveState } from "../viewers/RecordingView";
import HtmlView from "../viewers/HtmlView";
import ImageView from "../viewers/ImageView";
import MarkdownView from "../viewers/MarkdownView";
import TextView from "./TextView";

// The heavy viewers (monaco-editor, pdfjs-dist, xlsx, docx-preview, the live
// recording editor) load on demand so they stay out of the eager startup
// bundle. All are default exports, so lazy() needs no remapping. They live in
// a rebuildable bundle (not module consts) because lazy() caches a rejected
// import forever — ViewerChunkBoundary's Retry swaps in fresh wrappers so the
// import actually re-runs.
const makeLazyViewers = () => ({
  CodeEditor: lazy(() => import("../viewers/CodeEditor")),
  DocxView: lazy(() => import("../viewers/DocxView")),
  PdfView: lazy(() => import("../viewers/PdfView")),
  RecordingView: lazy(() => import("../viewers/RecordingView")),
  SheetView: lazy(() => import("../viewers/SheetView")),
});
let lazyViewers = makeLazyViewers();

/** The lazy viewers above are the app's first dynamic imports, and a rejected
 * chunk fetch (classically: the updater replaced the bundle on disk while the
 * old process is still running, then the user opens their first PDF) would
 * otherwise throw through Suspense to the root and unmount the entire app.
 * Catch it here instead and offer a retry. */
class ViewerChunkBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => {
    lazyViewers = makeLazyViewers();
    this.setState({ failed: false });
  };
  render() {
    if (this.state.failed) {
      return (
        <div className="empty-hint">
          This viewer couldn't load — that can happen right after an app
          update.{" "}
          <button className="subtle" onClick={this.retry}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Copied from ../viewers/monacoSetup — importing it from there would pull all
// of monaco-editor into the eager bundle just for this extension lookup.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  xml: "xml",
  r: "r",
  lua: "lua",
  scala: "scala",
  pl: "perl",
};

function languageForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

interface ViewerRouterProps {
  openFile: OpenFile;
  viewerRev: number;
  editMode: boolean;
  editModeOf: (c: FileContent) => "grid" | "editor" | "copy" | null;
  editCell: (sheet: string, cell: string, value: string) => Promise<void>;
  saveEdit: (newText: string) => Promise<void>;
  saveEditAsCopy: (newText: string) => Promise<void>;
  /** Wave 1b (idea 10): mirrors the editable Monaco buffer's dirty flag out to
   * the workspace so agent writes can't silently blow unsaved user edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** ADD-27: what the Recording editor needs from the workspace — the live
   * session state plus the session-lifecycle handlers (recordingActions). */
  /** ADD-18: background-transcription state by file NAME (stt-progress) —
   * lets media viewers say "transcribing…" instead of "no transcript yet". */
  sttStatus?: Record<string, string>;
  recording: {
    live: RecordingLiveState | null;
    /** Stop→saved drain readout (null outside a save). */
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

/** The middle-pane viewer dispatch: given the open FileContent + edit state,
 * render the right viewer/editor. Extracted verbatim from Workspace's viewer
 * body; the shell still owns all state and passes the callbacks. One Suspense
 * boundary around the whole dispatch (not per-branch) so a mounted viewer is
 * never remounted by a sibling lazy chunk loading. */
export default function ViewerRouter(props: ViewerRouterProps) {
  return (
    <ViewerChunkBoundary>
      <Suspense fallback={<div className="empty-hint">Loading viewer…</div>}>
        <ViewerBody {...props} />
      </Suspense>
    </ViewerChunkBoundary>
  );
}

function ViewerBody({
  openFile,
  viewerRev,
  editMode,
  editModeOf,
  editCell,
  saveEdit,
  saveEditAsCopy,
  onDirtyChange,
  recording,
  sttStatus,
}: ViewerRouterProps) {
  const { CodeEditor, DocxView, PdfView, RecordingView, SheetView } =
    lazyViewers;
  const c = openFile.content;
  const t = openFile.target;
  const mode = editModeOf(c);
  // Edit mode: per-format editors. Monaco is keyed by edit
  // state too — it takes value/readOnly at mount only.
  if (editMode && mode === "grid") {
    return (
      <SheetView
        key={`${openFile.id}-grid-${viewerRev}`}
        dataB64={c.dataB64}
        text={c.text}
        target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
        editable
        onEditCell={editCell}
      />
    );
  }
  if (editMode && mode === "editor") {
    return (
      <CodeEditor
        key={`${openFile.id}-edit-${viewerRev}`}
        value={c.text ?? ""}
        language={languageForFile(c.name)}
        onSave={saveEdit}
        find={t?.find}
        onDirtyChange={onDirtyChange}
      />
    );
  }
  if (editMode && mode === "copy") {
    return (
      <CodeEditor
        key={`${openFile.id}-copy-${viewerRev}`}
        value={c.text ?? ""}
        language="markdown"
        onSave={saveEditAsCopy}
        saveLabel="Save copy"
        find={t?.find}
        onDirtyChange={onDirtyChange}
      />
    );
  }
  // Preview mode. Code gets a read-only Monaco (syntax
  // colors) — the Edit button unlocks it.
  if (c.kind === "code") {
    return (
      <CodeEditor
        key={`${openFile.id}-view-${viewerRev}`}
        value={c.text ?? ""}
        language={languageForFile(c.name)}
        readOnly
        find={t?.find}
      />
    );
  }
  switch (c.kind) {
    case "image":
      return (
        <ImageView
          key={`${openFile.id}-${viewerRev}`}
          fileId={openFile.id}
          name={c.name}
          mime={c.mime}
          dataB64={c.dataB64 ?? ""}
        />
      );
    case "pdf":
      return (
        <PdfView
          key={`${openFile.id}-${viewerRev}`}
          dataB64={c.dataB64 ?? ""}
          target={{ page: t?.page, quote: t?.quote ?? t?.find }}
        />
      );
    case "docx":
      return (
        <DocxView
          key={`${openFile.id}-${viewerRev}`}
          dataB64={c.dataB64 ?? ""}
          target={{ quote: t?.quote ?? t?.find }}
        />
      );
    case "sheet":
      return (
        <SheetView
          key={`${openFile.id}-${viewerRev}`}
          dataB64={c.dataB64}
          target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
        />
      );
    case "csv":
      return (
        <SheetView
          key={`${openFile.id}-${viewerRev}`}
          text={c.text}
          target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
        />
      );
    case "markdown":
      return (
        <MarkdownView
          key={`${openFile.id}-${viewerRev}`}
          text={c.text ?? ""}
          target={{ quote: t?.quote ?? t?.find }}
        />
      );
    // HTML renders live in a sandboxed runner; Edit drops to
    // Monaco for the source.
    case "html":
      return (
        <HtmlView
          key={`${openFile.id}-${viewerRev}`}
          source={c.text ?? ""}
          name={c.name}
        />
      );
    case "text":
      return (
        <TextView
          key={`${openFile.id}-${viewerRev}`}
          text={c.text ?? ""}
          quote={t?.quote ?? t?.find}
        />
      );
    // ADD-27: the live Recording file — its own editor (live transcript,
    // speakers, transcript-based deletion, translate).
    case "recording":
      return (
        <RecordingView
          key={`${openFile.id}-${viewerRev}`}
          fileId={openFile.id}
          mediaToken={c.mediaToken}
          live={recording.live}
          saveProgress={recording.saveProgress}
          pushToast={recording.pushToast}
          onStart={recording.onStart}
          onPause={recording.onPause}
          onResume={recording.onResume}
          onStop={recording.onStop}
        />
      );
    // ADD-18: recordings/videos with a clickable transcript.
    case "audio":
    case "video":
      return (
        <AudioView
          key={`${openFile.id}-${viewerRev}`}
          kind={c.kind}
          fileId={openFile.id}
          mime={c.mime}
          dataB64={c.dataB64 ?? ""}
          mediaToken={c.mediaToken}
          text={c.text}
          target={{ quote: t?.quote ?? t?.find }}
          transcribing={sttStatus?.[c.name] === "processing"}
        />
      );
    default:
      return (
        <div className="empty-hint">
          No preview available for this file type yet. Its
          content is still stored safely inside the room.
        </div>
      );
  }
}
