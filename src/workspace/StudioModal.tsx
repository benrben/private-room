import { useEffect } from "react";
import { tokenAtCaret } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The "edit the prompt first" modal for Studio actions. Run fires a background
 * job and closes the modal immediately — progress and the finished file live on
 * the sidebar job card, so there is no in-modal running state. */
export default function StudioModal({ s, a }: { s: WSState; a: WSActions }) {
  // Escape closes the modal (unless the autocomplete's own Escape closes it
  // first). Capture-phase so the app-level Escape (close file viewer) never
  // fires underneath the dialog.
  const open = s.studioPrompt !== null;
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (s.studioAc) return; // the autocomplete's own Escape closes it first
      s.setStudioPrompt(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.studioAc]);
  if (!s.studioPrompt) return null;
  const studioPrompt = s.studioPrompt;
  const label =
    studioPrompt.kind === "flashcards"
      ? "Flashcards"
      : studioPrompt.kind === "mindmap"
        ? "Mind map"
        : "Podcast script";
  return (
    <div
      className="studio-prompt-backdrop"
      onClick={() => s.setStudioPrompt(null)}
    >
      <div
        className="studio-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-prompt-title">
          {label} · {studioPrompt.scope ? "this file" : "whole room"}
        </div>
        <p className="studio-prompt-hint">
          Edit the prompt the AI will follow, then run it. Type{" "}
          <strong>@</strong> to add a specific file or folder — otherwise your
          whole {studioPrompt.scope ? "file" : "room"} is used.
        </p>
        <div className="studio-prompt-field">
          {s.studioAc && a.studioAcItems().length > 0 && (
            <div className="ac-popover studio-ac-popover">
              <div className="ac-hint ac-hint-row">
                <span>{a.studioAcItems().length} files &amp; folders</span>
                <span className="ac-keys">↑↓ choose · Enter add · Esc close</span>
              </div>
              {a.studioAcItems().map((it, i) => (
                <button
                  key={it.key}
                  className={`ac-item ${i === s.studioAc!.index ? "active" : ""}`}
                  ref={(el) => {
                    if (i === s.studioAc!.index)
                      el?.scrollIntoView({ block: "nearest" });
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    a.acceptMention(it.insert, s.studioPrompt, s.setStudioPrompt);
                  }}
                >
                  <span className="ac-label">{it.label}</span>
                  <span className="ac-desc">{it.hint}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={s.studioPromptRef}
            className="studio-prompt-input"
            value={studioPrompt.text}
            autoFocus
            rows={4}
            dir="auto"
            onChange={(e) => {
              const val = e.target.value;
              const caret = e.target.selectionStart;
              s.setStudioPrompt((p) => (p ? { ...p, text: val } : p));
              const tok = tokenAtCaret(val, caret);
              s.setStudioAc(
                tok && tok.kind === "ref"
                  ? { kind: "ref", query: tok.query, start: tok.start, index: 0 }
                  : null,
              );
            }}
            onKeyDown={(e) => {
              const items = a.studioAcItems();
              if (s.studioAc && items.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  s.setStudioAc({
                    ...s.studioAc,
                    index: (s.studioAc.index + 1) % items.length,
                  });
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  s.setStudioAc({
                    ...s.studioAc,
                    index:
                      (s.studioAc.index - 1 + items.length) % items.length,
                  });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  a.acceptMention(
                    items[Math.min(s.studioAc.index, items.length - 1)].insert,
                    s.studioPrompt,
                    s.setStudioPrompt,
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  s.setStudioAc(null);
                  return;
                }
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void a.runStudioFromModal();
              }
            }}
          />
        </div>
        <div className="studio-prompt-actions">
          <button className="subtle" onClick={() => s.setStudioPrompt(null)}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!studioPrompt.text.trim()}
            onClick={() => void a.runStudioFromModal()}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
