import { tokenAtCaret } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The editable-prompt modal for an AI action. Reuses the Studio prompt CSS +
 * the shared @-mention autocomplete. Extracted verbatim from renderAiActionModal. */
export default function AiActionModal({ s, a }: { s: WSState; a: WSActions }) {
  if (!s.aiPrompt) return null;
  const aiPrompt = s.aiPrompt;
  const def = aiPrompt.def;
  const running = s.aiBusy;
  // ADD-27: "translate" reuses the question field to carry the language.
  const questionMissing =
    (def.needsQuestion || def.needsLanguage) && !aiPrompt.question.trim();
  return (
    <div
      className="studio-prompt-backdrop"
      onClick={() => {
        if (!running) s.setAiPrompt(null);
      }}
    >
      <div className="studio-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="studio-prompt-title">
          {def.title} ·{" "}
          {aiPrompt.refs && aiPrompt.refs.length
            ? "this file"
            : aiPrompt.scope
              ? "this folder"
              : "whole room"}
        </div>
        <p className="studio-prompt-hint">
          {def.description} Edit the prompt the AI will follow, then run it.
          Type <strong>@</strong> to add a specific file or folder as context.
        </p>
        {def.needsLanguage && (
          <>
            <input
              className="studio-prompt-question"
              list="ai-action-langs"
              placeholder="Target language — English, עברית, Español, 中文…"
              value={aiPrompt.question}
              autoFocus
              disabled={running}
              dir="auto"
              onChange={(e) => {
                const q = e.target.value;
                s.setAiPrompt((p) => (p ? { ...p, question: q } : p));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void a.runAiActionFromModal();
                }
              }}
            />
            <datalist id="ai-action-langs">
              {[
                "English", "עברית (Hebrew)", "Español (Spanish)", "Français (French)",
                "Deutsch (German)", "العربية (Arabic)", "Русский (Russian)", "中文 (Chinese)",
                "日本語 (Japanese)", "Português (Portuguese)", "Italiano (Italian)",
                "हिन्दी (Hindi)", "Українська (Ukrainian)", "Türkçe (Turkish)",
              ].map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </>
        )}
        {def.needsQuestion && (
          <input
            className="studio-prompt-question"
            placeholder="Your question…"
            value={aiPrompt.question}
            autoFocus
            disabled={running}
            dir="auto"
            onChange={(e) => {
              const q = e.target.value;
              s.setAiPrompt((p) => (p ? { ...p, question: q } : p));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void a.runAiActionFromModal();
              }
            }}
          />
        )}
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
                    a.acceptAiMention(it.insert);
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
            value={aiPrompt.text}
            autoFocus={!def.needsQuestion}
            disabled={running}
            rows={4}
            dir="auto"
            onChange={(e) => {
              const val = e.target.value;
              const caret = e.target.selectionStart;
              s.setAiPrompt((p) => (p ? { ...p, text: val } : p));
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
                  a.acceptAiMention(
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
                void a.runAiActionFromModal();
              }
            }}
          />
        </div>
        <div className="studio-prompt-actions">
          <button
            className="subtle"
            disabled={running}
            onClick={() => s.setAiPrompt(null)}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={running || !aiPrompt.text.trim() || questionMissing}
            onClick={() => void a.runAiActionFromModal()}
          >
            {running ? "Running…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
