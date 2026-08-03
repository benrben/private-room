import { useEffect, useRef, useState, type ReactNode } from "react";
import monaco, { monacoTheme, watchMonacoTheme } from "./monacoSetup";
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
      {banner && !readOnly && <div className="editor-banner">{banner}</div>}
      {onSave && !readOnly && (
        <div className="editor-bar">
          <span className={`editor-dirty ${dirty ? "on" : ""}`}>
            {dirty ? "● unsaved changes" : "all changes saved"}
          </span>
          <button className="subtle btn-ic" onClick={() => void saveNow()}>
            <SaveIcon size={13} /> {saveLabel ?? "Save"} ⌘S
          </button>
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
