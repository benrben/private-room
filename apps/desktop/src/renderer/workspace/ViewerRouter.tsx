import { Component, Suspense, type ReactNode } from "react";

import { FileContent } from "../api";
import { OpenFile } from "./types";
import type { RecordingLiveState } from "../viewers/RecordingView";
import {
  EditMode,
  FORMATS,
  LazyViewers,
  makeLazyViewers,
  ViewerContext,
} from "../viewers/registry";
import { languageForFile } from "../viewers/languages";
import { encodingSaveNote, EncodingState } from "../viewers/TextEncoding";
import PageSource from "../viewers/PageSource";

/** The lazy viewer bundle. Rebuildable (not a module const) because lazy()
 * caches a rejected import forever — the boundary's Retry swaps in fresh
 * wrappers so the import actually re-runs. */
let lazyViewers: LazyViewers = makeLazyViewers();

/** The lazy viewers are the app's first dynamic imports, and a rejected chunk
 * fetch (classically: the updater replaced the bundle on disk while the old
 * process is still running, then the user opens their first PDF) would
 * otherwise throw through Suspense to the root and unmount the entire app.
 * Catch it here instead and offer a retry. */
class ViewerChunkBoundary extends Component<
  { children: ReactNode; resetKey: string },
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
  // A caught chunk failure otherwise LATCHES: the boundary never unmounts, so
  // the next document the reader opened — a plain note whose chunk is already
  // in memory — drew the failure card instead of itself until Retry was
  // pressed. Opening something else IS the retry.
  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey)
      this.retry();
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="empty-hint">
          This viewer couldn't load — that can happen right after an app update.{" "}
          <button className="subtle" onClick={this.retry}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface ViewerRouterProps {
  openFile: OpenFile;
  viewerRev: number;
  editMode: boolean;
  editModeOf: (c: FileContent) => EditMode | null;
  /** How the open file's bytes are being decoded, and the picker/alert to
   * show for it. P1-4 lifted the hook that makes this up to ViewerPane, so
   * its own header can draw the same picker in the overflow menu — this
   * component used to call `useTextEncoding` itself and never shared the
   * result with anything outside its own subtree. */
  enc: EncodingState;
  editCell: (sheet: string, cell: string, value: string) => Promise<void>;
  /** Both resolve false when the write failed, so the editor keeps the buffer
   * dirty and the unsaved-edits dialog doesn't proceed with a lost edit. */
  saveEdit: (newText: string) => Promise<boolean>;
  saveEditAsCopy: (newText: string) => Promise<boolean>;
  /** Wave 1b (idea 10): mirrors the editable Monaco buffer's dirty flag out to
   * the workspace so agent writes can't silently blow unsaved user edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Lets the workspace save the editor's buffer when something is about to
   * unmount it (the unsaved-edits dialog's "Save"). */
  registerSave?: (save: (() => Promise<boolean>) | null) => void;
  /** ADD-18: background-transcription state by file NAME (stt-progress) —
   * lets media viewers say "transcribing…" instead of "no transcript yet". */
  sttStatus?: Record<string, string>;
  recording: ViewerContext["recording"] & { live: RecordingLiveState | null };
}

/**
 * The middle-pane viewer dispatch.
 *
 * This used to be a ~110-line `switch` over file kinds — one of the three
 * places (with Rust's `classify_file` and the frontend's `editModeOf`) that
 * had to agree about what a file is. All three are now one table each side:
 * `src-tauri/src/formats.rs` says what a file IS, `src/viewers/registry.tsx`
 * says what it looks like, and this file only decides between "edit" and
 * "preview" and holds the Suspense/error boundary.
 *
 * One Suspense boundary around the whole dispatch (not per-branch) so a
 * mounted viewer is never remounted by a sibling lazy chunk loading.
 */
export default function ViewerRouter(props: ViewerRouterProps) {
  return (
    <ViewerChunkBoundary
      resetKey={`${props.openFile.id}-${props.openFile.content.kind}`}
    >
      <Suspense fallback={<div className="empty-hint">Loading viewer…</div>}>
        <ViewerBody {...props} />
      </Suspense>
    </ViewerChunkBoundary>
  );
}

/**
 * A plain sentence, above the buffer, about what pressing Save will do.
 *
 * The editors all LOOK the same — a monospace pane — while meaning three very
 * different things: rewrite this file, rewrite the words inside a Word document
 * that keeps its layout, or write a separate note and leave the original alone.
 * Live QA's verdict on the whole area was "hard to see what's edit", and the
 * only thing distinguishing these was the tooltip on a button the user had
 * already clicked.
 */
function editBanner(
  mode: EditMode,
  name: string,
  encodingNote?: string | null,
): ReactNode {
  // A file that isn't UTF-8 is CONVERTED by being saved — the writer only
  // writes UTF-8 — and on a detected encoding that conversion rests on a guess.
  // Saying so here is the point: it is the last screen before the rewrite.
  if (mode === "editor" && encodingNote) {
    return encodingNote;
  }
  if (mode === "docx") {
    return (
      <>
        You're editing the words of <strong dir="auto">{name}</strong>. Saving
        writes them back into the Word file, keeping its styles, tables and
        images — so you can reword paragraphs, but not add or delete them.
      </>
    );
  }
  if (mode === "copy") {
    return (
      <>
        This is the text read out of <strong dir="auto">{name}</strong>, which
        can't be edited in place. Saving creates a{" "}
        <strong>separate note</strong> in the room; the original file is left
        exactly as it is.
      </>
    );
  }
  return null;
}

interface ViewerRoute {
  props: ViewerRouterProps;
  content: FileContent;
  mode: EditMode | null;
  revision: string;
}

function contentForEncoding(
  content: FileContent,
  enc: EncodingState,
): FileContent {
  // How this file's bytes are being decoded, and the user's override if they
  // gave one — owned by ViewerPane now (see the prop doc above), still a
  // no-op for every kind whose text is read OUT of a container.
  if (enc.text === null) return content;
  // The re-read is the single source for both the text and whether it may
  // be edited: a reading that produced replacement characters is not the
  // file, so its editor must not open.
  return {
    ...content,
    text: enc.text,
    editable: enc.decoded?.editable ?? false,
  };
}

function gridEditor({ props, content }: ViewerRoute): ReactNode {
  const { SheetView } = lazyViewers;
  const target = props.openFile.target;
  return (
    <SheetView
      // NOT keyed by `viewerRev` here, unlike every other branch. A grid edit
      // writes the file, and that write raises the `file-updated` the
      // workspace answers by bumping `viewerRev` — so the grid remounted on
      // its OWN commit, throwing away the change marks and the ⌘Z history
      // that are the only way back out of a cell edit, once per cell. The
      // component is built for this: it overlays committed values on the
      // workbook it parsed at open (see `editedAt`) and re-reads the bytes
      // itself when the streaming token changes.
      key={`${props.openFile.id}-grid`}
      mediaToken={content.mediaToken}
      dataB64={content.dataB64}
      text={content.kind === "csv" ? content.text : undefined}
      target={{ sheet: target?.sheet, range: target?.range ?? target?.cell }}
      editable
      onEditCell={props.editCell}
    />
  );
}

function markdownEditor({ props, content, revision }: ViewerRoute): ReactNode {
  const { MarkdownEditor } = lazyViewers;
  return (
    <MarkdownEditor
      key={`${props.openFile.id}-md-${revision}`}
      value={content.text ?? ""}
      onSave={props.saveEdit}
      // A .md is a raw-text file like any other, so a legacy-encoded one is
      // CONVERTED by being saved. This editor has the same banner slot as
      // Monaco's and was the one path that didn't say so.
      banner={editBanner(
        "editor",
        content.name,
        encodingSaveNote(props.enc.decoded),
      )}
      registerSave={props.registerSave}
      onDirtyChange={props.onDirtyChange}
      find={props.openFile.target?.find}
    />
  );
}

function plainTextEditor({ props, content, revision }: ViewerRoute): ReactNode {
  const { CodeEditor } = lazyViewers;
  return (
    <CodeEditor
      key={`${props.openFile.id}-edit-${revision}`}
      value={content.text ?? ""}
      language={languageForFile(content.name)}
      onSave={props.saveEdit}
      banner={editBanner(
        "editor",
        content.name,
        encodingSaveNote(props.enc.decoded),
      )}
      registerSave={props.registerSave}
      find={props.openFile.target?.find}
      onDirtyChange={props.onDirtyChange}
    />
  );
}

function docxEditor({ props, content, revision }: ViewerRoute): ReactNode {
  const { CodeEditor } = lazyViewers;
  return (
    <CodeEditor
      key={`${props.openFile.id}-edit-${revision}`}
      value={content.text ?? ""}
      language="plaintext"
      onSave={props.saveEdit}
      saveLabel="Save into the Word file"
      banner={editBanner(
        "docx",
        content.name,
        encodingSaveNote(props.enc.decoded),
      )}
      registerSave={props.registerSave}
      find={props.openFile.target?.find}
      onDirtyChange={props.onDirtyChange}
    />
  );
}

function editorForText(route: ViewerRoute): ReactNode {
  return route.content.kind === "markdown"
    ? markdownEditor(route)
    : plainTextEditor(route);
}

function copyEditor({ props, content }: ViewerRoute): ReactNode {
  const { CodeEditor } = lazyViewers;
  return (
    <CodeEditor
      key={`${props.openFile.id}-copy-${props.viewerRev}`}
      value={content.text ?? ""}
      language="markdown"
      onSave={props.saveEditAsCopy}
      saveLabel="Save as a new note"
      banner={editBanner("copy", content.name)}
      registerSave={props.registerSave}
      find={props.openFile.target?.find}
      onDirtyChange={props.onDirtyChange}
    />
  );
}

function copyEditorOrNull(route: ViewerRoute): ReactNode {
  return route.mode === "copy" ? copyEditor(route) : null;
}

function editViewer(route: ViewerRoute): ReactNode {
  if (!route.props.editMode) return null;
  if (route.mode === "grid") return gridEditor(route);
  if (route.mode === "editor") return editorForText(route);
  if (route.mode === "docx") return docxEditor(route);
  return copyEditorOrNull(route);
}

function previewViewer({ props, content, revision }: ViewerRoute): ReactNode {
  const entry = FORMATS[content.kind] ?? FORMATS.binary;
  return (
    <>
      {props.enc.alert}
      {/* A saved page says where it came from. Renders nothing for every file
          that is not one, and nothing for a page that declared nothing. */}
      <PageSource meta={content.webMeta} />
      <div
        key={`${props.openFile.id}-${content.kind}-${revision}`}
        className="viewer-host"
      >
        {entry.render({
          fileId: props.openFile.id,
          content,
          target: props.openFile.target,
          viewerRev: props.viewerRev,
          lazy: lazyViewers,
          editCell: props.editCell,
          saveEdit: props.saveEdit,
          sttStatus: props.sttStatus,
          recording: props.recording,
        })}
      </div>
    </>
  );
}

function ViewerBody(props: ViewerRouterProps) {
  const content = contentForEncoding(props.openFile.content, props.enc);
  const route = {
    props,
    content,
    mode: props.editModeOf(content),
    // Monaco takes its value at MOUNT, so a re-decode has to remount it or the
    // buffer would keep showing the encoding the user just overruled.
    revision: `${props.viewerRev}-${props.enc.key}`,
  };
  const editor = editViewer(route);
  if (editor) return editor;
  return previewViewer(route);
}
