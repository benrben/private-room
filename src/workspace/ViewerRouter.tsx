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
    <ViewerChunkBoundary>
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
function editBanner(mode: EditMode, name: string, encodingNote?: string | null): ReactNode {
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
        can't be edited in place. Saving creates a <strong>separate note</strong>{" "}
        in the room; the original file is left exactly as it is.
      </>
    );
  }
  return null;
}

function ViewerBody({
  openFile,
  viewerRev,
  editMode,
  editModeOf,
  enc,
  editCell,
  saveEdit,
  saveEditAsCopy,
  onDirtyChange,
  registerSave,
  recording,
  sttStatus,
}: ViewerRouterProps) {
  // How this file's bytes are being decoded, and the user's override if they
  // gave one — owned by ViewerPane now (see the prop doc above), still a
  // no-op for every kind whose text is read OUT of a container.
  const c =
    enc.text === null
      ? openFile.content
      : // The re-read is the single source for both the text and whether it may
        // be edited: a reading that produced replacement characters is not the
        // file, so its editor must not open.
        { ...openFile.content, text: enc.text, editable: enc.decoded?.editable ?? false };
  const t = openFile.target;
  const mode = editModeOf(c);
  const { CodeEditor, MarkdownEditor, SheetView } = lazyViewers;
  // Monaco takes its value at MOUNT, so a re-decode has to remount it or the
  // buffer would keep showing the encoding the user just overruled.
  const rev = `${viewerRev}-${enc.key}`;

  // ---- edit mode: per-format editors -----------------------------------
  // Monaco is keyed by edit state too — it takes value/readOnly at mount only.
  if (editMode && mode === "grid") {
    return (
      <SheetView
        key={`${openFile.id}-grid-${viewerRev}`}
        mediaToken={c.mediaToken}
        dataB64={c.dataB64}
        text={c.kind === "csv" ? c.text : undefined}
        target={{ sheet: t?.sheet, range: t?.range ?? t?.cell }}
        editable
        onEditCell={editCell}
      />
    );
  }
  // A Markdown note edits in a split view — source beside the rendered page —
  // rather than as a bare monospace buffer with the page hidden behind a toggle.
  if (editMode && mode === "editor" && c.kind === "markdown") {
    return (
      <MarkdownEditor
        key={`${openFile.id}-md-${rev}`}
        value={c.text ?? ""}
        onSave={saveEdit}
        // A .md is a raw-text file like any other, so a legacy-encoded one is
        // CONVERTED by being saved. This editor has the same banner slot as
        // Monaco's and was the one path that didn't say so.
        banner={editBanner(mode, c.name, encodingSaveNote(enc.decoded))}
        registerSave={registerSave}
        onDirtyChange={onDirtyChange}
        find={t?.find}
      />
    );
  }
  if (editMode && (mode === "editor" || mode === "docx")) {
    // `docx` edits the EXTRACTED text and writes it back into the Word file
    // paragraph by paragraph; `editor` rewrites a plain-text file whole. Both
    // are in-place saves, so both get the same editor — only `saveEdit`
    // differs, and the workspace picks the right writer from the file's kind.
    return (
      <CodeEditor
        key={`${openFile.id}-edit-${rev}`}
        value={c.text ?? ""}
        language={mode === "docx" ? "plaintext" : languageForFile(c.name)}
        onSave={saveEdit}
        saveLabel={mode === "docx" ? "Save into the Word file" : undefined}
        banner={editBanner(mode, c.name, encodingSaveNote(enc.decoded))}
        registerSave={registerSave}
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
        saveLabel="Save as a new note"
        banner={editBanner(mode, c.name)}
        registerSave={registerSave}
        find={t?.find}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  // ---- preview: one lookup, no switch ----------------------------------
  // Only the ALERT card rides above the preview now (not the editors: those
  // already have a banner slot, and the reading is chosen before you start
  // typing) — an error or a lossy read is worth interrupting the page for.
  // The routine reading and the control to change it live in ViewerPane's
  // overflow menu instead; see EncodingAlert/EncodingPicker in
  // TextEncoding.tsx for why the two are split.
  const entry = FORMATS[c.kind] ?? FORMATS.binary;
  return (
    <>
      {enc.alert}
      {/* A saved page says where it came from. Renders nothing for every file
          that is not one, and nothing for a page that declared nothing. */}
      <PageSource meta={c.webMeta} />
      <div key={`${openFile.id}-${c.kind}-${rev}`} className="viewer-host">
        {entry.render({
          fileId: openFile.id,
          content: c,
          target: t,
          viewerRev,
          lazy: lazyViewers,
          editCell,
          saveEdit,
          sttStatus,
          recording,
        })}
      </div>
    </>
  );
}
