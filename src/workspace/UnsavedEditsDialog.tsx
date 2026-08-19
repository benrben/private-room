import { useEffect, useRef, useState } from "react";
import { PendingLeave, WSState } from "./state";
import { useFocusTrap } from "../settings/useFocusTrap";
import "./unsaved.css";

/**
 * The "you have unsaved edits" door.
 *
 * WHAT IT REPLACED: nothing, on most exits. Locking the room and quitting the
 * app each asked their own question, and switching tabs refused with a toast
 * ("Save your edits first") — but pressing Close on the viewer simply threw the
 * buffer away and returned to Home, silently. Live QA hit that on a `.pptx` and
 * again on a `.docx`: type, press Close, the work is gone with no dialog and no
 * undo. A toast that BLOCKS is nearly as bad in the other direction — it names
 * a problem and offers no way out of it, so the only route forward is to guess
 * that undoing the edit will free the tab.
 *
 * So: one question, three real answers, on every exit that unmounts the editor.
 * Save writes and then continues; Discard continues; Cancel stays put. Save is
 * the default because the edit is the thing the user made and the navigation is
 * the thing they can repeat.
 *
 * The dialog body is a CHILD component, mounted only while a question is up:
 * this component is rendered for the whole life of the workspace and returns
 * null most of the time, so a focus trap called here would run its move-focus-in
 * effect once, at workspace mount, and never again.
 */
export default function UnsavedEditsDialog({ s }: { s: WSState }) {
  const pending = s.pendingLeave;
  if (!pending) return null;
  return <UnsavedEditsBody s={s} pending={pending} />;
}

function UnsavedEditsBody({ s, pending }: { s: WSState; pending: PendingLeave }) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");
  const saveRef = useRef<HTMLButtonElement>(null);
  // It says aria-modal, so Tab must not walk out of it onto the workspace
  // chrome behind the veil — which includes the file list that decides which
  // file this very dialog is about.
  const { modalRef, onModalKeyDown } = useFocusTrap(() => s.setPendingLeave(null));

  useEffect(() => {
    // Save is the default answer. The trap's own mount effect has just put
    // focus on the first control, and this one runs after it.
    saveRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Capture phase: the app-level Escape closes the open file, which is
      // precisely the data loss this dialog exists to prevent.
      e.stopPropagation();
      s.setPendingLeave(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run the held-up navigation. The dirty flag is cleared FIRST: the guard
   * reads it, and a stale `true` would stop the very action being resumed. */
  function go() {
    s.editorDirtyRef.current = false;
    s.setPendingLeave(null);
    pending.proceed();
  }

  async function saveThenGo() {
    const save = s.editorSaveRef.current;
    if (!save) {
      // No editor registered a save — nothing can be written, so the only
      // honest options left are discard and cancel.
      setFailed("This editor can't save from here. Use Discard or Cancel.");
      return;
    }
    setSaving(true);
    setFailed("");
    const ok = await save().catch(() => false);
    setSaving(false);
    // A failed write must NOT continue: that would lose the edit exactly the
    // way pressing Discard would, while the button said Save.
    if (!ok) {
      setFailed("That didn't save, so nothing was closed. Your edit is still in the editor.");
      return;
    }
    go();
  }

  return (
    <div className="unsaved-backdrop" onClick={() => s.setPendingLeave(null)}>
      <div
        className="unsaved-modal"
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="unsaved-title" id="unsaved-title">
          Save your changes?
        </h2>
        <p className="unsaved-body">
          {s.openFile ? (
            <>
              <strong dir="auto">{s.openFile.content.name}</strong> has edits you
              haven't saved. {pending.what} now would lose them.
            </>
          ) : (
            <>You have edits you haven't saved. {pending.what} now would lose them.</>
          )}
        </p>
        {failed && (
          <p className="unsaved-failed" role="alert">
            {failed}
          </p>
        )}
        <div className="unsaved-actions">
          {/* Cancel sits apart from the two that leave, so the destructive one
              is never the neighbour of the safe one. */}
          <button className="subtle" onClick={() => s.setPendingLeave(null)}>
            Cancel
          </button>
          <span className="unsaved-spacer" />
          <button className="subtle unsaved-discard" disabled={saving} onClick={go}>
            Discard changes
          </button>
          <button
            className="primary"
            ref={saveRef}
            disabled={saving}
            onClick={() => void saveThenGo()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
