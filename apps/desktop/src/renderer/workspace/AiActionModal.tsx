import { useEffect } from "react";
import { CloudIcon } from "../icons";
import { tokenAtCaret } from "./composer";
import { isCloudRoute } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The editable-prompt modal for an AI action. Reuses the Studio prompt CSS +
 * the shared @-mention autocomplete. Extracted verbatim from renderAiActionModal. */
export default function AiActionModal({ s, a }: { s: WSState; a: WSActions }) {
  // Escape closes this window, exactly as it closes Studio, Compare and the
  // usage popover. Without it, Escape reached the app-level handler and closed
  // the FILE behind the dialog while the dialog stayed put. Capture-phase, and
  // never while the action is running (that would strand the run's own state).
  const open = s.aiPrompt !== null;
  const running = s.aiBusy;
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // The @-file list closes FIRST, and its Escape lives on the textarea —
      // stopping here would swallow the key at `window` before React's root
      // ever saw it, so with the popover up Escape closed neither the list nor
      // the dialog. Bail before the stop, not after it. (Nothing underneath
      // acts on it either: the app-level handler ignores Escape while the
      // focus is in an input or textarea.)
      if (s.studioAc) return;
      e.stopPropagation();
      if (running) return;
      s.setAiPrompt(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running, s.studioAc]);
  if (!s.aiPrompt) return null;
  const aiPrompt = s.aiPrompt;
  const def = aiPrompt.def;
  // ADD-27: "translate" reuses the question field to carry the language.
  const questionMissing =
    (def.needsQuestion || def.needsLanguage) && !aiPrompt.question.trim();
  // `aiPrompt.scope` is the OPEN FILE's id (AiPane passes `s.openFile?.id`, and
  // the host reads it with `get_file_extracted_text`) — never a folder. The
  // title has been calling it "this folder" for a while, which was merely wrong
  // copy until a privacy sentence started repeating it.
  const refCount = aiPrompt.refs?.length ?? 0;
  const scopeLabel =
    refCount > 1
      ? `these ${refCount} files`
      : refCount === 1 || aiPrompt.scope
        ? "this file"
        : "whole room";
  return (
    <div
      className={`studio-prompt-backdrop${running ? " running" : ""}`}
      onClick={() => {
        if (!running) s.setAiPrompt(null);
      }}
    >
      <div
        className="studio-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={def.title}
        aria-busy={running}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-prompt-title">
          {def.title} · {scopeLabel}
        </div>
        <p className="studio-prompt-hint">
          {def.description} Edit the prompt the AI will follow, then run it.
          Type <strong>@</strong> to add a specific file or folder as context.
        </p>
        {/* The same strip the composer draws, for the same reason — except the
            composer waits for typing and this prompt arrives prefilled, so the
            route alone is the condition. Every other place content is handed to
            a model says where it goes; this is the widest-scoped send there is.
            No "Use local" here: switching the room's model out from under an
            open dialog is a different decision than the one being made.

            It does NOT re-name the scope the title just named. The material is
            not the scope: a room-wide run sends the first 12 KB the host can
            gather (`gather_scope_text`), and an @-mention in the prompt adds a
            file or folder the title never mentioned. "Everything it reads" is
            the one phrasing that stays true through both. */}
        {isCloudRoute(s.model, s.ai) && (
          <div className="cloud-strip">
            <span className="cloud-strip-label">
              <CloudIcon size={14} />
              This room uses a cloud model — the prompt and everything this
              action reads leave your Mac.
            </span>
          </div>
        )}
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
                    a.acceptMention(it.insert, s.aiPrompt, s.setAiPrompt);
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
            // `needsLanguage` reuses the question field, and the Run button is
            // disabled until it is filled — so it, not the prompt, is what the
            // caret has to land in. Two autoFocus in one mount and the later
            // mount wins.
            autoFocus={!def.needsQuestion && !def.needsLanguage}
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
                  a.acceptMention(
                    items[Math.min(s.studioAc.index, items.length - 1)].insert,
                    s.aiPrompt,
                    s.setAiPrompt,
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
          {/* A Studio build has had Stop and Resume all along; a Summarize over
              a whole room — the same work, from the same shelf — had neither,
              and while it ran this window's Cancel was grey and clicking
              outside did nothing. So the only honest thing to offer during a
              run is a way to END it, in the place the Run button was. */}
          {running ? (
            <>
              <span className="studio-prompt-hint" aria-live="polite">
                <span className="btn-spinner" aria-hidden="true" /> Running…
              </span>
              <button
                className="subtle danger"
                disabled={s.aiStopping || !s.aiOpId}
                onClick={() => void a.stopAiAction()}
              >
                {s.aiStopping ? "Stopping…" : "Stop"}
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={!aiPrompt.text.trim() || questionMissing}
              onClick={() => void a.runAiActionFromModal()}
            >
              Run
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
