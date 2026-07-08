import { tokenAtCaret } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The "edit the prompt first" modal for Studio actions. Extracted verbatim from
 * renderStudioPromptModal. */
export default function StudioModal({ s, a }: { s: WSState; a: WSActions }) {
  if (!s.studioPrompt) return null;
  const studioPrompt = s.studioPrompt;
  const label =
    studioPrompt.kind === "flashcards"
      ? "Flashcards"
      : studioPrompt.kind === "mindmap"
        ? "Mind map"
        : "Podcast script";
  const running = s.studioBusy !== null;
  return (
    <div
      className="studio-prompt-backdrop"
      onClick={() => {
        if (!running) s.setStudioPrompt(null);
      }}
    >
      <div className="studio-prompt" onClick={(e) => e.stopPropagation()}>
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
              <div className="ac-hint">Add a file or folder as context</div>
              {a.studioAcItems().map((it, i) => (
                <button
                  key={it.key}
                  className={`ac-item ${i === s.studioAc!.index ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    a.acceptStudioMention(it.insert);
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
            disabled={running}
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
                  a.acceptStudioMention(
                    items[Math.min(s.studioAc.index, items.length - 1)].insert,
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
          <button
            className="subtle"
            disabled={running}
            onClick={() => s.setStudioPrompt(null)}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={running || !studioPrompt.text.trim()}
            onClick={() => void a.runStudioFromModal()}
          >
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
