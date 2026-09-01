import { type FileContent, type FileTarget, type Message } from "../api";
import { ocrBody } from "../viewers/util";
import { textOf } from "../viewers/htmlText";
import { parseCues } from "../viewers/subtitles";
import {
  AutocompleteItem,
  hoistSkill,
  hoistTag,
  parseComposer,
  specialistErrorMessage,
} from "./composer";
import {
  BrowserScope,
  ChatScope,
  ROOM_ONLY,
} from "./browserScope";
import { WSState } from "./state";

/** Edit-approval ids already declined by a turn teardown. `setEditApprovals`'
 * updater is allowed to run more than once for one update (StrictMode, a
 * re-entrant render), so the decline it fires has to be idempotent. */
export const declinedApprovals = new Set<string>();

/** Held from the moment an outgoing turn is accepted until it is over.
 *
 * `s.asking` cannot do this job: the run is only registered inside `runTurn`,
 * and every path to it awaits something first — the live page read under a
 * browser scope, the deletes an edit or a regenerate does. Two Enters inside
 * that round trip both read `asking === false`, both started a turn in the same
 * chat, and the first to finish deleted the chat's run slot — leaving the second
 * answer streaming with no overlay and no Stop. Module state, like the scope
 * above: `makeChatActions` is rebuilt on every render, so a closure variable
 * would be a fresh `false` each time.
 *
 * Keyed BY CHAT, exactly as `s.asking` is (`isAsking(runs, chatId)`): a run
 * belongs to its conversation, so a turn still streaming in one chat must not
 * silently swallow the Enter pressed in another — the composer stays typable
 * while an answer is running, and a Send that does nothing at all is the worse
 * failure of the two. */
export const sendInFlight = new Set<string>();

/**
 * WHAT THE NEXT TURN IS ANSWERED FROM.
 *
 * Module state, deliberately. One fact with three readers and no owner between
 * them: the strip that states the scope is in AiPane, the placeholder that
 * echoes it is three levels down in the composer, and the send that has to make
 * it true is here. AiPane is the single writer — it is the surface the user
 * changes the scope on — and everything else subscribes.
 *
 * Read at SEND time, like `viewing` in `askOnce`: the turn is what the scope
 * has to describe, not whatever was on screen when the box was first focused.
 */
let turnScope: ChatScope = ROOM_ONLY;
export const scopeReaders = new Set<() => void>();

export function setTurnScope(next: ChatScope): void {
  if (next === turnScope) return;
  turnScope = next;
  for (const notify of scopeReaders) notify();
}

export function currentTurnScope(): ChatScope {
  return turnScope;
}

export function subscribeTurnScope(notify: () => void): () => void {
  scopeReaders.add(notify);
  return () => {
    scopeReaders.delete(notify);
  };
}

/**
 * How each scope reads the page it names.
 *
 * "selection" is deliberately absent from this table rather than mapped to a
 * mode: it does not read the page at all, it reads what a person has
 * highlighted on it, through a different command. The two are kept apart here
 * so that a scope with no read path CANNOT fall through to the whole room —
 * `scopedQuestion` refuses instead, which is the behaviour this table exists to
 * guarantee.
 */
export const PAGE_TEXT_MODE: Partial<Record<BrowserScope, "main" | "full">> = {
  page: "main",
};

/** Write to the clipboard, and say either that it worked or WHAT failed.
 *
 * The failure used to be reported as `String(e)`, which is right for the Rust
 * commands — they throw written sentences — and wrong for this one: the
 * browser rejects with a DOMException, so a refused write put
 * "NotAllowedError: Write permission denied." on screen as the whole message,
 * naming neither the act nor which of the Copy buttons it was. It is also the
 * one error here whose cause is known at the call site. */
export function copyToClipboard(s: WSState, text: string, done: string): void {
  navigator.clipboard.writeText(text).then(
    () => s.pushToast("success", done),
    () =>
      s.pushToast(
        "error",
        "Couldn't copy — macOS refused clipboard access to Arcelle.",
      ),
  );
}

/** The provenance line `run_stt_job` puts in front of a transcript, for the
 * same reason `OCR_PREFIX` exists: the model has to know the words are a
 * machine reading. See `commands/stt_cmds.rs` — the two strings have to stay
 * identical. */
export const TRANSCRIPT_PREFIX = "(transcribed from recording)";

export type ParsedComposer = ReturnType<typeof parseComposer>;

export function transcriptText(text: string): string {
  return text.startsWith(TRANSCRIPT_PREFIX)
    ? text.slice(TRANSCRIPT_PREFIX.length).trimStart()
    : text;
}

export function htmlReadableText(text: string): string {
  return textOf(text) || text;
}

export function subtitleReadableText(text: string): string {
  const cues = parseCues(text);
  return cues.length > 0 ? cues.map((cue) => cue.text).join("\n\n") : text;
}

export const READABLE_TEXT_BY_KIND: Partial<Record<FileContent["kind"], (text: string) => string>> = {
  image: (text) => ocrBody(text) ?? "",
  audio: transcriptText,
  video: transcriptText,
  recording: transcriptText,
  html: htmlReadableText,
  subtitle: subtitleReadableText,
};

/** The words in a file, without what was stamped on them for the MODEL.
 *
 * Two kinds carry such a line — a picture's OCR prefix, a recording's
 * transcript prefix. `ImageView` already keeps its one off the screen; the
 * audio card still draws its own as the transcript's first line, so this is
 * the one place the two agree, and it agrees with the reason the prefixes
 * exist: they are an instruction to the model, not a caption to paste under
 * someone's photograph. Two more formats simply store something other than
 * what is on screen: an .html file's markup, and a subtitle file's cue numbers
 * and `-->` timecodes.
 *
 * Never empty when the file has text: an extractor that finds nothing returns
 * the stored text rather than silently handing back a blank clipboard. */
export function readableText(c: FileContent): string {
  const text = c.text ?? "";
  return READABLE_TEXT_BY_KIND[c.kind]?.(text) ?? text;
}

export function composerValidationMessage(
  parsed: ParsedComposer,
  commands: Parameters<typeof parseComposer>[1],
  specialists: Parameters<typeof specialistErrorMessage>[1],
): string | null {
  if (parsed.specialistError) return specialistErrorMessage(parsed.specialistError, specialists);
  if (parsed.tagConflict) {
    return "A message can name a specialist (*), a skill (/) or an action (#) — not two of them.";
  }
  if (parsed.commandError) {
    const names = commands.map((command) => `#${command.name}`).join(", ");
    return `#${parsed.commandError} isn't a command. Try: ${names || "(none available)"}`;
  }
  if (parsed.skillError) {
    return `/${parsed.skillError} isn't an enabled skill. Type / to choose from enabled skills.`;
  }
  return null;
}

export function outgoingComposerText(text: string, parsed: ParsedComposer): string {
  if (parsed.skill) return hoistSkill(text, parsed.skill);
  if (parsed.specialist) return hoistTag(text, parsed.specialist);
  return text;
}

export function optimisticUserMessage(content: string): Message {
  return {
    id: `pending-${Date.now()}`,
    role: "user",
    content,
    sources: [],
    createdAt: "",
    effects: null,
  };
}

export function nextAutocompleteIndex(
  key: string,
  current: number,
  items: AutocompleteItem[],
): number | null {
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (step === 0) return null;
  let index = current;
  for (let count = 0; count < items.length; count += 1) {
    index = (index + step + items.length) % items.length;
    if (!items[index].disabled) return index;
  }
  return index;
}

export function selectedAutocompleteItem(
  key: string,
  current: number,
  items: AutocompleteItem[],
): AutocompleteItem | null {
  if (key !== "Enter" && key !== "Tab") return null;
  return items[Math.min(current, items.length - 1)] ?? null;
}

/** Chat sessions + the AI-turn flow + the composer's #, @, / and * autocomplete. Cross-hook
 * deps threaded from the shell: files' viewFile (openSource), recording's
 * openOllamaApp/downloadModel/refreshAi (turn error remediation), misc's
 * playSealSound (lock ritual). onLock is the App-level lock. */

import { makeChatCore } from "./chatCore";
import { makeComposerActions } from "./chatComposerActions";
import { makeChatTail } from "./chatTailActions";

export type ChatActionDeps = {
  viewFile: (id: string, target?: FileTarget) => Promise<void>;
  openOllamaApp: () => Promise<void>;
  downloadModel: (name: string) => Promise<void>;
  refreshAi: () => Promise<void>;
  playSealSound: () => void;
};

export function makeChatActions(
  s: WSState,
  onLock: () => void | Promise<void>,
  deps: ChatActionDeps,
) {
  const core = makeChatCore(s, deps);
  const composer = makeComposerActions(s, core);
  const actions = makeChatTail(s, composer, onLock);
  const { newChat, removeChat, runTurn, askOnce, askAgainWithRealDetails, send, autocompleteItems, autocompleteNote, refreshSpecialists, refreshAutocomplete, insertComposerToken, acceptAutocomplete, dismissAutocomplete, onComposerKeyDown, stopAsk, handleLock, regenerate, editAndResend, copyMessage, copyConversation, copyAllText, openSource, startRename, commitRename, onComposerPaste, makeMinutes, saveToRoom, toggleAttach, handoffContext } = actions;
  return { newChat, removeChat, runTurn, askOnce, askAgainWithRealDetails, send, autocompleteItems, autocompleteNote, refreshSpecialists, refreshAutocomplete, insertComposerToken, acceptAutocomplete, dismissAutocomplete, onComposerKeyDown, stopAsk, handleLock, regenerate, editAndResend, copyMessage, copyConversation, copyAllText, openSource, startRename, commitRename, onComposerPaste, makeMinutes, saveToRoom, toggleAttach, handoffContext };
}
