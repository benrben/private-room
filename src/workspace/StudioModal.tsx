import { useEffect, useRef, useState } from "react";
import { tokenAtCaret } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The "edit the prompt first" modal for Studio actions. Extracted verbatim from
 * renderStudioPromptModal. */
export default function StudioModal({ s, a }: { s: WSState; a: WSActions }) {
  // ADD-31: elapsed-seconds ticker while a run is in flight, so the wait is
  // visibly alive even between stage changes.
  const [elapsed, setElapsed] = useState(0);
  const busy = s.studioBusy !== null;
  const stopBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    // The textarea just went disabled, dropping focus to <body> — hand it to
    // Stop so Space/Enter keeps working and a screen reader hears the switch.
    stopBtnRef.current?.focus();
    return () => window.clearInterval(t);
  }, [busy]);
  // Escape closes the modal while idle (running keeps it up — Stop is the
  // explicit exit). Capture-phase so the app-level Escape (close file viewer)
  // never fires underneath the dialog.
  const open = s.studioPrompt !== null;
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (s.studioAc) return; // the autocomplete's own Escape closes it first
      if (s.studioBusy === null) s.setStudioPrompt(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.studioAc, s.studioBusy]);
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
      className={`studio-prompt-backdrop${running ? " running" : ""}`}
      onClick={() => {
        if (!running) s.setStudioPrompt(null);
      }}
    >
      <div
        className="studio-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={running}
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
        {/* ADD-31: a live status line replaces the anonymous "Running…" —
            named stage plus elapsed seconds, and a Stop that actually works. */}
        {running && (
          <div className="studio-prompt-status" role="status">
            <span className="studio-prompt-stage">
              {s.studioStep ?? "Starting…"}
            </span>
            <span className="studio-prompt-elapsed">
              {Math.floor(elapsed / 60) > 0
                ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                : `${elapsed}s`}
            </span>
          </div>
        )}
        <div className="studio-prompt-actions">
          {running ? (
            <button
              ref={stopBtnRef}
              className="subtle"
              onClick={() => a.stopStudio()}
            >
              Stop
            </button>
          ) : (
            <button className="subtle" onClick={() => s.setStudioPrompt(null)}>
              Cancel
            </button>
          )}
          <button
            className={`primary${running ? " running" : ""}`}
            disabled={running || !studioPrompt.text.trim()}
            onClick={() => void a.runStudioFromModal()}
          >
            {running ? (
              <>
                <span className="btn-spinner" aria-hidden="true" /> Running…
              </>
            ) : (
              "Run"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
