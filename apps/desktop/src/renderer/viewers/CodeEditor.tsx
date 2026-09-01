import { useEffect, useRef, useState, type ReactNode } from "react";
import monaco, {
  EDITOR_FONT,
  monacoTheme,
  remeasureWhenFontReady,
  watchMonacoTheme,
} from "./monacoSetup";
import { SaveIcon } from "../icons";

/** Build the toolbar operations for a live editor.
 *
 * Everything is pushed with `executeEdits`, which appends to monaco's own undo
 * stack — so ⌘Z steps back through toolbar presses and typing alike. Writing
 * the model directly (`setValue`) would have been shorter and would have made
 * every button un-undoable. */
function makeFormatApi(editor: monaco.editor.IStandaloneCodeEditor): EditorFormatApi {
  /** The selection, widened to the word under the cursor when nothing is
   * selected — pressing Bold with a caret in a word should embolden the word,
   * not insert an empty `****`. */
  function target(): monaco.Range {
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!sel || !model) return new monaco.Range(1, 1, 1, 1);
    if (!sel.isEmpty()) return monaco.Range.lift(sel);
    const word = model.getWordAtPosition(sel.getStartPosition());
    if (!word) return monaco.Range.lift(sel);
    return new monaco.Range(
      sel.startLineNumber,
      word.startColumn,
      sel.startLineNumber,
      word.endColumn,
    );
  }

  function apply(range: monaco.Range, text: string) {
    editor.executeEdits("toolbar", [{ range, text, forceMoveMarkers: true }]);
    editor.focus();
  }

  return {
    wrap(before, after) {
      const model = editor.getModel();
      if (!model) return;
      const range = target();
      const inner = model.getValueInRange(range);
      // Already wrapped? Take it off, so the button toggles.
      if (inner.startsWith(before) && inner.endsWith(after) && inner.length >= before.length + after.length) {
        apply(range, inner.slice(before.length, inner.length - after.length));
        return;
      }
      apply(range, `${before}${inner}${after}`);
    },
    linePrefix(prefix) {
      const model = editor.getModel();
      const sel = editor.getSelection();
      if (!model || !sel) return;
      const from = sel.startLineNumber;
      const to = sel.endLineNumber;
      const lines: string[] = [];
      let allPrefixed = true;
      for (let n = from; n <= to; n += 1) {
        const line = model.getLineContent(n);
        lines.push(line);
        if (!line.startsWith(prefix)) allPrefixed = false;
      }
      const next = lines
        .map((l) => (allPrefixed ? l.slice(prefix.length) : `${prefix}${l}`))
        .join("\n");
      apply(new monaco.Range(from, 1, to, model.getLineMaxColumn(to)), next);
    },
    insert(text) {
      const sel = editor.getSelection();
      apply(sel ? monaco.Range.lift(sel) : new monaco.Range(1, 1, 1, 1), text);
    },
  };
}

/** What a formatting toolbar can do to the buffer. Every operation goes
 * through monaco's edit stack, so ⌘Z undoes a toolbar press exactly like it
 * undoes typing — a toolbar that bypassed it would be an un-undoable button. */
export interface EditorFormatApi {
  /** Surround the selection (or the word at the cursor) — `**bold**`. Pressing
   * the same button on already-wrapped text takes the wrapping off again. */
  wrap(before: string, after: string): void;
  /** Add `prefix` to every selected line — `## `, `- `, `> `. Pressing it on
   * lines that already carry the prefix removes it. */
  linePrefix(prefix: string): void;
  /** Drop text in at the cursor, replacing the selection. */
  insert(text: string): void;
}

interface Props {
  value: string;
  language: string;
  readOnly?: boolean;
  /** Resolves false when the write failed, so the caller can keep the buffer
   * and the dirty flag. `void` counts as success (the older callers). */
  onSave?: (value: string) => void | Promise<boolean | void>;
  /** Text to scroll to and select once the editor mounts. */
  find?: string;
  /** Save-button label, e.g. "Save copy" when saving creates a new file. */
  saveLabel?: string;
  /** A note above the editor saying what saving will actually DO — whether it
   * rewrites this file, writes a separate copy, or can't write it back at all. */
  banner?: ReactNode;
  /** Hands the workspace a way to save this buffer from outside, for the
   * unsaved-edits dialog: only the editor holds the text, and the dialog runs
   * at the moment the editor is about to be unmounted. Called with null on
   * unmount so a dead editor is never asked to save. */
  registerSave?: (save: (() => Promise<boolean>) | null) => void;
  /** Live buffer text, on every keystroke — for a side-by-side preview. */
  onChange?: (value: string) => void;
  /** Hands out the selection-editing operations a formatting toolbar needs, so
   * a toolbar can exist without importing monaco or holding the editor. */
  registerFormat?: (api: EditorFormatApi | null) => void;
  /** Wave 1b (idea 10): mirrors the buffer's dirty flag out to the workspace
   * (s.editorDirtyRef) so an agent write can tell "user has unsaved edits"
   * from "viewer can safely reload". Called with false again on save AND on
   * unmount — a stale true would make later agent writes silently skip the
   * viewer reload for a user who isn't even editing. */
  onDirtyChange?: (dirty: boolean) => void;
}

function editorBanner(banner: ReactNode | undefined, readOnly: boolean | undefined): ReactNode {
  return banner && !readOnly && <div className="editor-banner">{banner}</div>;
}

function editorToolbar({
  language,
  dirty,
  onSave,
  readOnly,
  saveLabel,
  save,
}: {
  language: string;
  dirty: boolean;
  onSave: Props["onSave"];
  readOnly: boolean | undefined;
  saveLabel: string | undefined;
  save: () => void;
}): ReactNode {
  return onSave && !readOnly && (
    <div className="editor-bar">
      {/* What this buffer IS, at the head of its own bar. The bar used to
          open with a dirty flag and nothing else, so a code file's header
          said only whether it had been typed in. Blue is the product's
          informational marker and the word carries the fact — this is a
          label, not a status.

          The auto margin is inline because .editor-bar (viewer-formats.css,
          another owner's file) justifies its children to the end, and there
          is no margin utility in the shared primitives to say this with. */}
      <span className="nb-cat nb-mark-blue" style={{ marginRight: "auto" }}>
        {language}
      </span>
      {/* Unsaved work is a state to notice, which is what the yellow marker
          means product-wide — and it arrives as a strip of tape, so the
          change is a SHAPE as well as a hue. The saved state deliberately
          gets no mark at all: a permanent green badge saying nothing is
          wrong is noise, and the resting state of a buffer should be calm.
          The wording is unchanged; `editor-dirty` is dropped in the dirty
          case only because its `.on` colour would fight the tape's ink. */}
      <span className={dirty ? "nb-tape nb-sem-pending" : "editor-dirty"}>
        {dirty ? "● unsaved changes" : "all changes saved"}
      </span>
      {/* Saving is the one action in this bar, so it is drawn as a real
          outlined control rather than as a third flat link. */}
      <button className="nb-btn btn-ic" onClick={save}>
        <SaveIcon size={14} /> {saveLabel ?? "Save"} ⌘S
      </button>
    </div>
  );
}

export default function CodeEditor({
  value,
  language,
  readOnly,
  onSave,
  find,
  saveLabel,
  banner,
  registerSave,
  onChange,
  registerFormat,
  onDirtyChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const registerSaveRef = useRef(registerSave);
  registerSaveRef.current = registerSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const registerFormatRef = useRef(registerFormat);
  registerFormatRef.current = registerFormat;
  /** The text as last written (or as opened). "Dirty" means "differs from
   * this", not "has been typed in since it opened". */
  const savedTextRef = useRef(value);
  const [dirty, setDirty] = useState(false);

  function markDirty(d: boolean) {
    setDirty(d);
    onDirtyChangeRef.current?.(d);
  }

  /** Save the buffer. Resolves false when the write failed, so neither ⌘S nor
   * the unsaved-edits dialog can report success for a save that didn't land. */
  async function saveNow(): Promise<boolean> {
    const editor = editorRef.current;
    const fn = onSaveRef.current;
    if (!editor || !fn) return false;
    const text = editor.getValue();
    const result = await fn(text);
    if (result === false) return false;
    savedTextRef.current = text;
    markDirty(false);
    return true;
  }
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language,
      theme: monacoTheme(),
      readOnly: !!readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: EDITOR_FONT,
      fontSize: 13,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      padding: { top: 10 },
    });
    editorRef.current = editor;
    // COMPARE, don't latch. Setting dirty=true on any change meant undoing back
    // to the original left "● unsaved changes" showing and the tab still
    // blocked — live QA hit exactly that: ⌘Z removed the typing and the editor
    // still insisted there was something to save.
    const sub = editor.onDidChangeModelContent(() => {
      const text = editor.getValue();
      markDirty(text !== savedTextRef.current);
      onChangeRef.current?.(text);
    });
    registerFormatRef.current?.(makeFormatApi(editor));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveNowRef.current();
    });
    // Let the workspace save this buffer when it is about to be unmounted.
    registerSaveRef.current?.(() => saveNowRef.current());
    return () => {
      sub.dispose();
      editor.dispose();
      registerSaveRef.current?.(null);
      registerFormatRef.current?.(null);
      // The buffer is gone with the editor — never leave dirty=true behind.
      onDirtyChangeRef.current?.(false);
    };
    // The parent keys this component by file id, so mount-once is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the app's light/dark switch instead of staying black in light mode.
  useEffect(watchMonacoTheme, []);

  /** The first line of the file has to be on screen when the file opens.
   *
   * Two things can leave it above the fold. The bundled monospace face can
   * land after monaco has measured its glyph box, which relays every line out
   * under a scroll offset computed for the old one; and the editor can be
   * built while the centre pane is still settling, so its first layout is
   * against a height it is about to lose. Live QA caught the result on a .js
   * file — the gutter began at line 2, with the opening comment clipped at the
   * top edge.
   *
   * So: remeasure once the face is really there, then put the viewport back at
   * the top — unless something has deliberately gone elsewhere. A citation
   * reveal and any reader input both count, which is why this WATCHES rather
   * than assumes. Correcting a scroll position out from under someone who
   * navigated on purpose would be a worse bug than the one it fixes. */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // `find` is read once on purpose: it is the citation this editor was
    // MOUNTED with. A later one arrives through the effect above, which moves
    // the selection — and that trips the same flag.
    let moved = !!find;
    const mark = () => {
      moved = true;
    };
    const subs = [
      editor.onKeyDown(mark),
      editor.onMouseDown(mark),
      editor.onDidChangeCursorPosition(mark),
    ];
    let alive = true;
    const settle = () => {
      if (!alive || moved) return;
      if (editor.getScrollTop() !== 0) editor.setScrollTop(0);
    };
    const raf = requestAnimationFrame(settle);
    void remeasureWhenFontReady().then(settle);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      subs.forEach((d) => d.dispose());
    };
    // Mount only: the parent keys this component by file id, so a different
    // file is a different editor with its own first line to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Jump to the word the AI (or a search result) pointed at. Runs on every
   * change of `find`, not once at mount — a second request in an already-open
   * file used to be ignored entirely. The find widget is opened seeded with
   * the term, so the FIRST hit is a starting point, not the only one: Enter /
   * ⌘G walks the rest. */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !find) return;
    const match = editor
      .getModel()
      ?.findMatches(find, false, false, false, null, false)[0];
    if (!match) return;
    editor.setSelection(match.range);
    editor.revealRangeInCenter(match.range);
    void editor.getAction("actions.find")?.run();
  }, [find]);

  return (
    <div className="code-editor">
      {editorBanner(banner, readOnly)}
      {editorToolbar({
        language,
        dirty,
        onSave,
        readOnly,
        saveLabel,
        save: () => void saveNow(),
      })}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
