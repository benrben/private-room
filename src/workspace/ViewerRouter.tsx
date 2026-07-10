import { FileContent } from "../api";
import { OpenFile } from "./types";
import AudioView from "../viewers/AudioView";
import RecordingView, { RecordingLiveState } from "../viewers/RecordingView";
import CodeEditor from "../viewers/CodeEditor";
import DocxView from "../viewers/DocxView";
import HtmlView from "../viewers/HtmlView";
import ImageView from "../viewers/ImageView";
import MarkdownView from "../viewers/MarkdownView";
import PdfView from "../viewers/PdfView";
import SheetView from "../viewers/SheetView";
import TextView from "./TextView";
import { languageForFile } from "../viewers/monacoSetup";

interface ViewerRouterProps {
  openFile: OpenFile;
  viewerRev: number;
  editMode: boolean;
  editModeOf: (c: FileContent) => "grid" | "editor" | "copy" | null;
  editCell: (sheet: string, cell: string, value: string) => Promise<void>;
  saveEdit: (newText: string) => Promise<void>;
  saveEditAsCopy: (newText: string) => Promise<void>;
  /** ADD-27: what the Recording editor needs from the workspace — the live
   * session state plus the session-lifecycle handlers (recordingActions). */
  recording: {
    live: RecordingLiveState | null;
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
 * body; the shell still owns all state and passes the callbacks. */
export default function ViewerRouter({
  openFile,
  viewerRev,
  editMode,
  editModeOf,
  editCell,
  saveEdit,
  saveEditAsCopy,
  recording,
}: ViewerRouterProps) {
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
          mime={c.mime}
          dataB64={c.dataB64 ?? ""}
          mediaToken={c.mediaToken}
          text={c.text}
          target={{ quote: t?.quote ?? t?.find }}
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
