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
      // Bail BEFORE stopping: the @-file list's own Escape lives on the
      // textarea, and a window-level capture stop never lets the key reach it
      // (same bug as AiActionModal — one shared shape, one shared fix).
      if (s.studioAc) return;
      e.stopPropagation();
      s.setStudioPrompt(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.studioAc]);
  if (!s.studioPrompt) return null;
  const studioPrompt = s.studioPrompt;
  const label = studioLabel(studioPrompt.kind);
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
          <StudioAutocomplete autocomplete={s.studioAc} items={a.studioAcItems()} prompt={s.studioPrompt} setPrompt={s.setStudioPrompt} acceptMention={a.acceptMention} />
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
            onKeyDown={(event) => handleStudioPromptKey(event, s, a)}
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

function studioLabel(kind: string): string {
  if (kind === "flashcards") return "Flashcards";
  if (kind === "mindmap") return "Mind map";
  return "Podcast script";
}

function StudioAutocomplete({
  autocomplete,
  items,
  prompt,
  setPrompt,
  acceptMention,
}: {
  autocomplete: WSState["studioAc"];
  items: ReturnType<WSActions["studioAcItems"]>;
  prompt: WSState["studioPrompt"];
  setPrompt: WSState["setStudioPrompt"];
  acceptMention: WSActions["acceptMention"];
}) {
  if (!autocomplete || items.length === 0) return null;
  return <div className="ac-popover studio-ac-popover"><div className="ac-hint ac-hint-row"><span>{items.length} files &amp; folders</span><span className="ac-keys">↑↓ choose · Enter add · Esc close</span></div>{items.map((item, index) => <StudioAutocompleteItem key={item.key} item={item} active={index === autocomplete.index} prompt={prompt} setPrompt={setPrompt} acceptMention={acceptMention} />)}</div>;
}

function StudioAutocompleteItem({
  item,
  active,
  prompt,
  setPrompt,
  acceptMention,
}: {
  item: ReturnType<WSActions["studioAcItems"]>[number];
  active: boolean;
  prompt: WSState["studioPrompt"];
  setPrompt: WSState["setStudioPrompt"];
  acceptMention: WSActions["acceptMention"];
}) {
  return <button className={`ac-item ${active ? "active" : ""}`} ref={(element) => scrollActiveItem(element, active)} onMouseDown={(event) => { event.preventDefault(); acceptMention(item.insert, prompt, setPrompt); }}><span className="ac-label">{item.label}</span><span className="ac-desc">{item.hint}</span></button>;
}

function scrollActiveItem(element: HTMLButtonElement | null, active: boolean) {
  if (!active) return;
  element?.scrollIntoView({ block: "nearest" });
}

function handleStudioPromptKey(event: React.KeyboardEvent<HTMLTextAreaElement>, s: WSState, a: WSActions) {
  if (handleAutocompleteKey(event, s, a)) return;
  if (!isStudioRunShortcut(event)) return;
  event.preventDefault();
  void a.runStudioFromModal();
}

function handleAutocompleteKey(event: React.KeyboardEvent<HTMLTextAreaElement>, s: WSState, a: WSActions): boolean {
  const autocomplete = s.studioAc;
  const items = a.studioAcItems();
  const action = autocompleteAction(event.key);
  if (!autocomplete || items.length === 0 || !action) return false;
  event.preventDefault();
  applyAutocompleteAction(action, autocomplete, items, s, a);
  return true;
}

function autocompleteAction(key: string): "next" | "previous" | "accept" | "dismiss" | null {
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (["Enter", "Tab"].includes(key)) return "accept";
  if (key === "Escape") return "dismiss";
  return null;
}

function applyAutocompleteAction(action: Exclude<ReturnType<typeof autocompleteAction>, null>, autocomplete: NonNullable<WSState["studioAc"]>, items: ReturnType<WSActions["studioAcItems"]>, s: WSState, a: WSActions) {
  if (action === "next") return s.setStudioAc({ ...autocomplete, index: (autocomplete.index + 1) % items.length });
  if (action === "previous") return s.setStudioAc({ ...autocomplete, index: (autocomplete.index - 1 + items.length) % items.length });
  if (action === "dismiss") return s.setStudioAc(null);
  return a.acceptMention(items[Math.min(autocomplete.index, items.length - 1)].insert, s.studioPrompt, s.setStudioPrompt);
}

function isStudioRunShortcut(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
