import {
  useEffect,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CloudIcon } from "../icons";
import { tokenAtCaret } from "./composer";
import { isCloudRoute } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";

type ModalProps = { s: WSState; a: WSActions };
type AiPrompt = NonNullable<WSState["aiPrompt"]>;

const LANGUAGES = [
  "English",
  "עברית (Hebrew)",
  "Español (Spanish)",
  "Français (French)",
  "Deutsch (German)",
  "العربية (Arabic)",
  "Русский (Russian)",
  "中文 (Chinese)",
  "日本語 (Japanese)",
  "Português (Portuguese)",
  "Italiano (Italian)",
  "हिन्दी (Hindi)",
  "Українська (Ukrainian)",
  "Türkçe (Turkish)",
];

function scopeLabel(prompt: AiPrompt) {
  const refCount = prompt.refs?.length ?? 0;
  if (refCount > 1) return `these ${refCount} files`;
  if (refCount === 1 || prompt.scope) return "this file";
  return "whole room";
}

function questionIsMissing(prompt: AiPrompt) {
  if (!prompt.def.needsQuestion && !prompt.def.needsLanguage) return false;
  return !prompt.question.trim();
}

function closeIfIdle(s: WSState, running: boolean) {
  if (!running) s.setAiPrompt(null);
}

function useModalEscape(s: WSState, open: boolean, running: boolean) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || s.studioAc) return;
      e.stopPropagation();
      closeIfIdle(s, running);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running, s.studioAc]);
}

function CloudNotice({ s }: Pick<ModalProps, "s">) {
  if (!isCloudRoute(s.model, s.ai)) return null;
  return (
    <div className="cloud-strip">
      <span className="cloud-strip-label">
        <CloudIcon size={14} />
        This room uses a cloud model — the prompt and everything this action
        reads leave your Mac.
      </span>
    </div>
  );
}

function setQuestion(s: WSState, question: string) {
  s.setAiPrompt((prompt) => (prompt ? { ...prompt, question } : prompt));
}

function submitFromQuestion(
  e: ReactKeyboardEvent<HTMLInputElement>,
  a: WSActions,
) {
  if (e.key !== "Enter" || (!e.metaKey && !e.ctrlKey)) return;
  e.preventDefault();
  void a.runAiActionFromModal();
}

function LanguageOptions() {
  return (
    <datalist id="ai-action-langs">
      {LANGUAGES.map((language) => (
        <option key={language} value={language} />
      ))}
    </datalist>
  );
}

function PromptInput({
  prompt,
  s,
  a,
  language,
}: ModalProps & { prompt: AiPrompt; language: boolean }) {
  return (
    <input
      className="studio-prompt-question"
      list={language ? "ai-action-langs" : undefined}
      placeholder={
        language
          ? "Target language — English, עברית, Español, 中文…"
          : "Your question…"
      }
      value={prompt.question}
      autoFocus
      disabled={s.aiBusy}
      dir="auto"
      onChange={(e) => setQuestion(s, e.target.value)}
      onKeyDown={(e) => submitFromQuestion(e, a)}
    />
  );
}

function LanguageQuestion(props: ModalProps & { prompt: AiPrompt }) {
  if (!props.prompt.def.needsLanguage) return null;
  return (
    <>
      <PromptInput {...props} language />
      <LanguageOptions />
    </>
  );
}

function TextQuestion(props: ModalProps & { prompt: AiPrompt }) {
  if (!props.prompt.def.needsQuestion) return null;
  return <PromptInput {...props} language={false} />;
}

function updatePrompt(s: WSState, e: ChangeEvent<HTMLTextAreaElement>) {
  const text = e.target.value;
  const token = tokenAtCaret(text, e.target.selectionStart);
  s.setAiPrompt((prompt) => (prompt ? { ...prompt, text } : prompt));
  s.setStudioAc(
    token && token.kind === "ref"
      ? { kind: "ref", query: token.query, start: token.start, index: 0 }
      : null,
  );
}

function mentionMoveDirection(key: string) {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  return null;
}

function isMentionAcceptKey(key: string) {
  return key === "Enter" || key === "Tab";
}

function moveMention(s: WSState, direction: number, itemCount: number) {
  const autocomplete = s.studioAc;
  if (!autocomplete) return;
  const index =
    direction > 0
      ? (autocomplete.index + 1) % itemCount
      : (autocomplete.index - 1 + itemCount) % itemCount;
  s.setStudioAc({ ...autocomplete, index });
}

function acceptMention(
  s: WSState,
  a: WSActions,
  items: ReturnType<WSActions["studioAcItems"]>,
) {
  const autocomplete = s.studioAc;
  if (!autocomplete || items.length === 0) return;
  const item = items[Math.min(autocomplete.index, items.length - 1)]!;
  a.acceptMention(item.insert, s.aiPrompt, s.setAiPrompt);
}

function handleAutocompleteKey(
  e: ReactKeyboardEvent<HTMLTextAreaElement>,
  s: WSState,
  a: WSActions,
  items: ReturnType<WSActions["studioAcItems"]>,
) {
  if (!s.studioAc || items.length === 0) return false;
  const direction = mentionMoveDirection(e.key);
  if (direction !== null) {
    e.preventDefault();
    moveMention(s, direction, items.length);
    return true;
  }
  if (isMentionAcceptKey(e.key)) {
    e.preventDefault();
    acceptMention(s, a, items);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    s.setStudioAc(null);
    return true;
  }
  return false;
}

function submitFromTextarea(
  e: ReactKeyboardEvent<HTMLTextAreaElement>,
  a: WSActions,
) {
  if (e.key !== "Enter" || (!e.metaKey && !e.ctrlKey)) return;
  e.preventDefault();
  void a.runAiActionFromModal();
}

function MentionPopover({ s, a }: ModalProps) {
  const autocomplete = s.studioAc;
  if (!autocomplete) return null;
  const items = a.studioAcItems();
  if (items.length === 0) return null;
  return (
    <div className="ac-popover studio-ac-popover">
      <div className="ac-hint">Add a file or folder as context</div>
      {items.map((item, index) => (
        <button
          key={item.key}
          className={`ac-item ${index === autocomplete.index ? "active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            a.acceptMention(item.insert, s.aiPrompt, s.setAiPrompt);
          }}
        >
          <span className="ac-label">{item.label}</span>
          <span className="ac-desc">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

function PromptField({ prompt, s, a }: ModalProps & { prompt: AiPrompt }) {
  return (
    <div className="studio-prompt-field">
      <MentionPopover s={s} a={a} />
      <textarea
        ref={s.studioPromptRef}
        className="studio-prompt-input"
        value={prompt.text}
        autoFocus={!prompt.def.needsQuestion && !prompt.def.needsLanguage}
        disabled={s.aiBusy}
        rows={4}
        dir="auto"
        onChange={(e) => updatePrompt(s, e)}
        onKeyDown={(e) => {
          const items = a.studioAcItems();
          if (handleAutocompleteKey(e, s, a, items)) return;
          submitFromTextarea(e, a);
        }}
      />
    </div>
  );
}

function RunningActions({ s, a }: ModalProps) {
  return (
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
  );
}

function ModalActions({ prompt, s, a }: ModalProps & { prompt: AiPrompt }) {
  const running = s.aiBusy;
  return (
    <div className="studio-prompt-actions">
      <button
        className="subtle"
        disabled={running}
        onClick={() => closeIfIdle(s, running)}
      >
        Cancel
      </button>
      {running ? (
        <RunningActions s={s} a={a} />
      ) : (
        <button
          className="primary"
          disabled={!prompt.text.trim() || questionIsMissing(prompt)}
          onClick={() => void a.runAiActionFromModal()}
        >
          Run
        </button>
      )}
    </div>
  );
}

/** The editable-prompt modal for an AI action. Reuses the Studio prompt CSS +
 * the shared @-mention autocomplete. */
export default function AiActionModal({ s, a }: ModalProps) {
  const prompt = s.aiPrompt;
  const running = s.aiBusy;
  useModalEscape(s, prompt !== null, running);
  if (!prompt) return null;
  return (
    <div
      className={`studio-prompt-backdrop${running ? " running" : ""}`}
      onClick={() => closeIfIdle(s, running)}
    >
      <div
        className="studio-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.def.title}
        aria-busy={running}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-prompt-title">
          {prompt.def.title} · {scopeLabel(prompt)}
        </div>
        <p className="studio-prompt-hint">
          {prompt.def.description} Edit the prompt the AI will follow, then run
          it. Type <strong>@</strong> to add a specific file or folder as
          context.
        </p>
        <CloudNotice s={s} />
        <LanguageQuestion prompt={prompt} s={s} a={a} />
        <TextQuestion prompt={prompt} s={s} a={a} />
        <PromptField prompt={prompt} s={s} a={a} />
        <ModalActions prompt={prompt} s={s} a={a} />
      </div>
    </div>
  );
}
