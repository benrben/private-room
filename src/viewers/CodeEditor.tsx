import { useEffect, useRef, useState } from "react";
import monaco from "./monacoSetup";
import { SaveIcon } from "../icons";

interface Props {
  value: string;
  language: string;
  readOnly?: boolean;
  onSave?: (value: string) => void;
  /** Text to scroll to and select once the editor mounts. */
  find?: string;
  /** Save-button label, e.g. "Save copy" when saving creates a new file. */
  saveLabel?: string;
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
  onDirtyChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const [dirty, setDirty] = useState(false);

  function markDirty(d: boolean) {
    setDirty(d);
    onDirtyChangeRef.current?.(d);
  }

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language,
      theme: "vs-dark",
      readOnly: !!readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      padding: { top: 10 },
    });
    editorRef.current = editor;
    if (find) {
      const match = editor
        .getModel()
        ?.findMatches(find, false, false, false, null, false)[0];
      if (match) {
        editor.setSelection(match.range);
        editor.revealRangeInCenter(match.range);
      }
    }
    const sub = editor.onDidChangeModelContent(() => markDirty(true));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (onSaveRef.current) {
        onSaveRef.current(editor.getValue());
        markDirty(false);
      }
    });
    return () => {
      sub.dispose();
      editor.dispose();
      // The buffer is gone with the editor — never leave dirty=true behind.
      onDirtyChangeRef.current?.(false);
    };
    // The parent keys this component by file id, so mount-once is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    const editor = editorRef.current;
    if (editor && onSave) {
      onSave(editor.getValue());
      markDirty(false);
    }
  }

  return (
    <div className="code-editor">
      {onSave && !readOnly && (
        <div className="editor-bar">
          <span className={`editor-dirty ${dirty ? "on" : ""}`}>
            {dirty ? "● unsaved changes" : "all changes saved"}
          </span>
          <button className="subtle btn-ic" onClick={save}>
            <SaveIcon size={13} /> {saveLabel ?? "Save"} ⌘S
          </button>
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
