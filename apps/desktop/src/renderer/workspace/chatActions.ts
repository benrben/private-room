import {
  ClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api, FileContent, FileTarget, memorySuggestion, Message } from "../api";
import { ocrBody } from "../viewers/util";
import { textOf } from "../viewers/htmlText";
import { parseCues } from "../viewers/subtitles";
import type { BrowserPageSelection, BrowserPageText } from "../apiTypes";
import {
  AutocompleteItem,
  fileToBase64,
  hoistSkill,
  hoistTag,
  parseComposer,
  specialistErrorMessage,
  specialistItems,
  specialistNote,
  tokenAtCaret,
  uniqueFileName,
} from "./composer";
import { runGuarded } from "./guard";
import { prefersReducedMotion } from "../rooms/helpers";
import { lostReplyNotice, speakerName, splitMarkupBlocks } from "./markup";
import {
  BrowserScope,
  ChatScope,
  ROOM_ONLY,
  pageContext,
  withPageContext,
  withSelectionContext,
  withPreamble,
} from "./browserScope";
import { HELP_COMMAND } from "./constants";
import * as voice from "./voice";
import { WSState } from "./state";

/** Edit-approval ids already declined by a turn teardown. `setEditApprovals`'
 * updater is allowed to run more than once for one update (StrictMode, a
 * re-entrant render), so the decline it fires has to be idempotent. */
const declinedApprovals = new Set<string>();

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
const sendInFlight = new Set<string>();

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
const scopeReaders = new Set<() => void>();

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
const PAGE_TEXT_MODE: Partial<Record<BrowserScope, "main" | "full">> = {
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
function copyToClipboard(s: WSState, text: string, done: string): void {
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
const TRANSCRIPT_PREFIX = "(transcribed from recording)";

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
function readableText(c: FileContent): string {
  const text = c.text ?? "";
  switch (c.kind) {
    case "image":
      return ocrBody(text) ?? "";
    case "audio":
    case "video":
    case "recording":
      return text.startsWith(TRANSCRIPT_PREFIX)
        ? text.slice(TRANSCRIPT_PREFIX.length).trimStart()
        : text;
    case "html":
      return textOf(text) || text;
    case "subtitle": {
      const cues = parseCues(text);
      return cues.length > 0 ? cues.map((cue) => cue.text).join("\n\n") : text;
    }
    default:
      return text;
  }
}

/** Chat sessions + the AI-turn flow + the composer's #, @, / and * autocomplete. Cross-hook
 * deps threaded from the shell: files' viewFile (openSource), recording's
 * openOllamaApp/downloadModel/refreshAi (turn error remediation), misc's
 * playSealSound (lock ritual). onLock is the App-level lock. */
export function makeChatActions(
  s: WSState,
  onLock: () => void | Promise<void>,
  deps: {
    viewFile: (id: string, target?: FileTarget) => Promise<void>;
    openOllamaApp: () => Promise<void>;
    downloadModel: (name: string) => Promise<void>;
    refreshAi: () => Promise<void>;
    playSealSound: () => void;
  },
) {
  const { viewFile, openOllamaApp, downloadModel, refreshAi, playSealSound } = deps;

  async function newChat() {
    try {
      const c = await api.createChat();
      s.setChats(await api.listChats());
      s.setActiveChatId(c.id);
    } catch (e) {
      s.pushToast("error", `Couldn't start a new chat: ${e}`);
    }
  }

  async function removeChat(id: string) {
    try {
      await api.deleteChat(id);
      const remaining = await api.listChats();
      if (remaining.length === 0) {
        const c = await api.createChat();
        s.setChats([c]);
        s.setActiveChatId(c.id);
      } else {
        s.setChats(remaining);
        if (s.activeChatId === id) s.setActiveChatId(remaining[0].id);
      }
    } catch (e) {
      s.pushToast("error", `Couldn't delete this chat: ${e}`);
    }
  }

  async function runTurn(run: (askId: string) => Promise<unknown>) {
    if (!s.activeChatId) return;
    const chatId = s.activeChatId;
    const askId = crypto.randomUUID();
    await runGuarded(s, () => run(askId), {
      begin: () => {
        // Owner replacement #4: register the run BEFORE the question is sent,
        // so this chat already knows which run id its events will carry — an
        // event naming any other run (a straggler from the turn before, another
        // chat's answer) is dropped rather than painted. Registering also
        // clears whatever the previous turn left in this chat's slot.
        s.beginRun(chatId, askId);
        s.setAskPrivacy(chatId, null);
        s.setMemSuggestion(null);
        s.editedRef.current = new Set();
        declinedApprovals.clear();
        // Idea 3: a new turn silences the old answer and opens a fresh voice
        // epoch (stale synthesis/decodes can never schedule audio into it).
        voice.beginTurn(chatId);
        s.setSpeakingMsgId(null);
      },
      // A user-pressed Stop is not a failure: no toast, and the model state is
      // not worth re-polling.
      ignore: (msg) => /cancel/i.test(msg),
      handle: (msg) => {
        if (!msg.includes("MODEL_MISSING")) return false;
        s.pushToast(
          "error",
          `Model "${s.model}" is not downloaded yet.`,
          { label: "Download", run: () => downloadModel(s.model) },
        );
        return true;
      },
      onError: () => {
        refreshAi();
      },
      openOllamaApp,
      finish: async () => {
        // EVERY reload below can fail (a locked/compacting room, a dropped
        // IPC). None of them may strand the composer on "Stop": the busy flags
        // are lowered in this function's own `finally`, whatever happens.
        try {
          const msgs = await api.getMessages(chatId);
          // Only paint the conversation the user is actually looking at. Switching
          // chats mid-answer used to repaint the OLD transcript under the NEW
          // header; the answer is filed correctly either way, and the chat-switch
          // effect loads the right messages.
          if (s.activeChatIdRef.current === chatId) s.setMessages(msgs);
          const lastMsg = msgs[msgs.length - 1];
          // Idea 3: flush the voice's sentence remainder. The fallback text
          // covers external CLI engines (they emit no ask-delta — the pipeline
          // was fed nothing, so endOfTurn speaks the persisted answer instead).
          // runGuarded runs this in `finally`, so a user-pressed Stop reaches
          // here too — endOfTurn no-ops then (stopAsk killed the turn's epoch).
          voice.endOfTurn(
            lastMsg?.role === "assistant"
              ? (lastMsg.effects ? lastMsg.content : splitMarkupBlocks(lastMsg.content).text)
              : undefined,
          );
          if (lastMsg?.role === "assistant" && lastMsg.content.trim()) {
            memorySuggestion(chatId)
              .then(async (sug) => {
                if (!(sug.worth && sug.fact.trim())) return;
                const fact = sug.fact.trim();
                // Wave 1b (idea 5): opt-in auto-save replaces the chip entirely.
                if (s.memAutoSaveRef.current) {
                  try {
                    const m = await api.addMemory(fact);
                    s.setMemories(await api.listMemories());
                    // addMemory dedups by returning the EXISTING row — only a
                    // genuinely new memory earns the toast + Forget undo, or the
                    // undo would delete a memory the user saved long ago.
                    const isNew =
                      Math.abs(Date.now() - Date.parse(m.createdAt)) < 10_000;
                    if (isNew) {
                      s.pushToast("success", `Remembered: ${fact}`, {
                        label: "Forget",
                        run: () => {
                          void api.deleteMemory(m.id).then(async () => {
                            s.setMemories(await api.listMemories());
                          });
                        },
                      });
                    }
                  } catch {
                    /* auto-save must never disturb the finished answer */
                  }
                } else if (s.activeChatIdRef.current === chatId) {
                  // The card belongs to THIS conversation. If the user has moved
                  // on, dropping it is right — it would otherwise appear pinned
                  // under a chat that never asked the question.
                  s.setMemSuggestion({ fact });
                }
              })
              .catch(() => {});
          }
          const edited = [...s.editedRef.current];
          if (edited.length) {
            const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
            if (lastAssistant) {
              s.setUndoByMsg((u) => ({ ...u, [lastAssistant.id]: edited }));
            }
          }
          s.setChats(await api.listChats());
          api.listFiles().then(s.setFiles).catch(() => {});
          api.listMemories().then(s.setMemories).catch(() => {});
        } catch (e) {
          s.pushToast(
            "error",
            `The answer finished but this chat couldn't be reloaded: ${e}`,
          );
        } finally {
          // The run is over: its registration and its whole live overlay go
          // together, in this chat's slot alone. No other conversation's
          // in-flight turn is touched.
          s.endRun(chatId);
          // Wave 2 (Idea 6): the run is over (finished OR stopped — this is
          // runGuarded's `finally`). Decline any diff-preview card still queued: the
          // tools/call task that awaits it is gone, so applying now would mutate a
          // turn that no longer exists (second-pass addendum).
          s.setEditApprovals((q) => {
            for (const r of q) {
              if (declinedApprovals.has(r.id)) continue;
              declinedApprovals.add(r.id);
              api.resolveEditApproval(r.id, "deny").catch(() => {});
            }
            return [];
          });
        }
      },
    });
  }

  async function askOnce(q: string, attachmentIds: string[], privacyBypass?: boolean) {
    const chatId = s.activeChatId;
    if (!chatId) return;
    // What is on screen as the question is sent. A ref, not state: this reads at
    // send time, and the turn is what the name has to describe.
    const viewing = s.openFileRef.current?.content.name ?? null;
    await runTurn((askId) =>
      api.ask(chatId, q, attachmentIds, askId, viewing, privacyBypass),
    );
  }

  /** PRIV-1 — the "this once" valve: re-ask the last question with the privacy
   * door open for one turn. Only ever called from the confirmed chat control
   * (which is agent-blocked); the confirm text says exactly what will leave. */
  async function askAgainWithRealDetails() {
    if (s.asking) return;
    const lastUser = [...s.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: lastUser.content,
      sources: [],
      createdAt: "",
      effects: null,
    };
    s.setMessages((m) => [...m, optimistic]);
    // Re-attach what the first attempt had. The @-mentions are parsed back out
    // of the saved text (the same recovery `regenerate` does), and anything
    // still on the paperclip rides along — asking again with the real details
    // but WITHOUT the evidence produced a worse answer for no stated reason.
    const parsed = parseComposer(
      lastUser.content,
      s.commands,
      s.skills,
      s.files,
      s.folders,
    );
    // …including the drawing the strip is scoped to. The saved text already
    // carries any block the first attempt prepended; the file it named is not
    // in the text, so without this a retry asks the same question with less
    // evidence than the question it is retrying.
    const attachmentIds = [
      ...new Set([
        ...s.attachments.map((f) => f.id),
        ...parsed.refIds,
        ...currentTurnScope().fileIds,
      ]),
    ];
    await askOnce(lastUser.content, attachmentIds, true);
  }

  /**
   * The question with the text the strip PROMISED in front of it, or the reason
   * there is none.
   *
   * Failure is reported, never absorbed. A page that refuses the extractor — it
   * is parked behind the results screen, it is a PDF, it returned nothing — has
   * to stop the turn: answering from the whole room instead would be a
   * different question, answered from different evidence, with nothing on
   * screen saying so.
   */
  /** The passage a person highlighted on the live page.
   *
   * A separate path from the page scope, not a mode of it: it asks a different
   * command, and its empty answer means something different. An empty
   * selection is `Ok` with no text — the flag that offered this scope is a
   * poll old, and the user can clear a selection in the time between the strip
   * rendering and the send — so it is reported as what it is rather than as a
   * page that returned nothing. */
  async function selectedPassage(
    question: string,
  ): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
    let got: BrowserPageSelection;
    try {
      got = await api.browserPageSelection();
    } catch (e) {
      return {
        ok: false,
        why: `The selection couldn't be read, so nothing was asked: ${e}`,
      };
    }
    if (!got.text.trim()) {
      return {
        ok: false,
        why: "Nothing is selected on the page any more, so nothing was asked.",
      };
    }
    return {
      ok: true,
      text: withSelectionContext(question, {
        title: got.title,
        url: got.url,
        text: got.text,
        // A real count, measured by the page script on the WHOLE selection.
        // `truncated` alone could only have produced "some of this is missing",
        // and the only alternative was a number nobody had measured.
        omitted: Math.max(0, got.total - got.text.length),
      }),
    };
  }

  async function scopedQuestion(
    scope: ChatScope,
    question: string,
  ): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
    if (scope.scope === "selection") return await selectedPassage(question);
    const mode = PAGE_TEXT_MODE[scope.scope];
    if (!mode) {
      return {
        ok: false,
        why: `This room can't read ${scope.label} yet, so nothing was asked.`,
      };
    }
    let got: BrowserPageText;
    try {
      got = await api.browserPageText(mode, 0);
    } catch (e) {
      return { ok: false, why: `The page couldn't be read, so nothing was asked: ${e}` };
    }
    const page = pageContext(got);
    if (!page) {
      return {
        ok: false,
        why: "This page returned no text — it may be a PDF, a canvas or a video. Nothing was asked.",
      };
    }
    return { ok: true, text: withPageContext(question, page) };
  }

  /** The strip's promise, applied to ONE outgoing question — the single place
   * every way of asking makes it true.
   *
   * A #command is exempt: it is not free text — it carries its own arguments and
   * picks its own sources — so a page block prepended to it would ride along in
   * something that never reads it.
   *
   * `ok: false` is a refusal to ask at all, never a downgrade: answering from
   * the whole room while the strip still reads "This page" would be a different
   * question, answered from different evidence, with nothing on screen saying
   * so. */
  async function applyScope(
    outgoing: string,
    isCommand: boolean,
  ): Promise<
    | { ok: true; text: string; fileIds: readonly string[] }
    | { ok: false; why: string }
  > {
    if (isCommand) return { ok: true, text: outgoing, fileIds: [] };
    const scope = currentTurnScope();
    if (scope.sendsPageText) {
      const scoped = await scopedQuestion(scope, outgoing);
      if (!scoped.ok) return scoped;
      return { ok: true, text: scoped.text, fileIds: scope.fileIds };
    }
    // A scope that already knows its evidence — the objects selected on the
    // open drawing — carries it straight in. Nothing to fetch, so nothing that
    // can fail; the empty preamble is the ordinary case and a no-op.
    return {
      ok: true,
      text: withPreamble(outgoing, scope.preamble),
      fileIds: scope.fileIds,
    };
  }

  /** Hold the send latch for one whole outgoing turn attempt, whatever it lands
   * on — a sent turn, a refusal, a thrown reload. */
  async function holdingSendLatch(chatId: string, run: () => Promise<void>) {
    sendInFlight.add(chatId);
    try {
      await run();
    } finally {
      sendInFlight.delete(chatId);
    }
  }

  /** `text` overrides the composer draft (hands-free dictation sends the
   * transcript directly — state updates would race a same-tick send). */
  async function send(text?: string) {
    // Sending is always a click/Enter/dictation gesture — the one reliable
    // moment to unlock the AudioContext for this turn's auto-speak (same
    // "must be first in the gesture" doctrine as acquireMic).
    voice.ensureUnlocked();
    const raw = (text ?? s.question).trim();
    // `handoffStarting` refuses a turn for the same reason `handoffContext`
    // refuses to compact during one: the two race over the same chat, and the
    // recap that becomes the model's whole memory of it would never have seen
    // the question saved beside it.
    const chatId = s.activeChatId;
    if (!raw || s.asking || s.handoffStarting || !chatId || sendInFlight.has(chatId))
      return;
    await holdingSendLatch(chatId, () => sendAccepted(raw));
  }

  async function sendAccepted(raw: string) {
    if (/^#help(\s|$)/i.test(raw)) {
      s.setAc(null);
      s.setShowHelp(true);
      // Only a bare "#help" is just a request for the list. "#help how do I…"
      // still opens it, but the question stays in the box — throwing away what
      // someone typed with no way to get it back is never the right answer.
      if (/^#help\s*$/i.test(raw)) s.setQuestion("");
      return;
    }
    const parsed = parseComposer(
      raw,
      s.commands,
      s.skills,
      s.files,
      s.folders,
      s.specialists,
    );
    if (parsed.specialistError) {
      s.pushToast(
        "error",
        specialistErrorMessage(parsed.specialistError, s.specialists),
      );
      return;
    }
    if (parsed.tagConflict) {
      // Refused rather than resolved: all three tokens are read from the first
      // position, so any order we picked would drop one of them without saying
      // so — and the user would watch a turn run as if they had not typed it.
      s.pushToast(
        "error",
        "A message can name a specialist (*), a skill (/) or an action (#) — not two of them.",
      );
      return;
    }
    if (parsed.commandError) {
      const names = s.commands.map((c) => `#${c.name}`).join(", ");
      s.pushToast(
        "error",
        `#${parsed.commandError} isn't a command. Try: ${names || "(none available)"}`,
      );
      return;
    }
    if (parsed.skillError) {
      s.pushToast(
        "error",
        `/${parsed.skillError} isn't an enabled skill. Type / to choose from enabled skills.`,
      );
      return;
    }
    s.setQuestion("");
    s.setAc(null);
    // The backend only reads "/skill" as the FIRST token, so a message that
    // names a file first has its skill hoisted to the front — otherwise it was
    // accepted and then quietly ignored. Sending and showing the same text
    // keeps the transcript honest about what was actually asked.
    // Same hoist for the "*" tag, which the sidecar also reads from the first
    // token (`agents.tagged_specialist`). The two never coexist — `tagConflict`
    // above refuses that message rather than choosing between them.
    const outgoing = parsed.skill
      ? hoistSkill(raw, parsed.skill)
      : parsed.specialist
        ? hoistTag(raw, parsed.specialist)
        : raw;
    // The strip's promise, made good.
    const scoped = await applyScope(outgoing, !!parsed.command);
    if (!scoped.ok) {
      // Nothing was sent, so the question goes back in the box: losing what
      // someone typed is a second failure on top of the one being reported.
      s.pushToast("error", scoped.why);
      s.setQuestion(raw);
      return;
    }
    const sending = scoped.text;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: sending,
      sources: [],
      createdAt: "",
      effects: null,
    };
    s.setMessages((m) => [...m, optimistic]);
    const chatId = s.activeChatId!;
    if (parsed.command) {
      s.setAttachments([]);
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, raw, askId),
      );
    } else {
      // The scope's own files ride ALONGSIDE what is pinned, never instead of
      // it: "“Portfolio map” + 2 attached" is what the strip says it will do,
      // and dropping a source someone deliberately pinned would be a change
      // they never asked for and could not see.
      const attachmentIds = [
        ...new Set([
          ...s.attachments.map((f) => f.id),
          ...parsed.refIds,
          ...scoped.fileIds,
        ]),
      ];
      s.setAttachments([]);
      await askOnce(sending, attachmentIds);
    }
  }

  // ---- "#"/"@"/"/"/"*" autocomplete ----

  /** The room's canonical specialists, for the "*" menu. Re-read every time
   * it opens rather than only at room open: provider/privacy/prerequisite
   * changes update each row's effective capability and explanation. */
  async function refreshSpecialists() {
    try {
      s.setSpecialists(await api.listSpecialists());
      s.setSpecialistsError("");
    } catch (e) {
      // The previous roster is NOT kept: it may be why the lookup failed (the
      // room's engine changed). Unknown is the honest state, and the menu says
      // so with the reason attached.
      s.setSpecialists(null);
      s.setSpecialistsError(String(e));
    }
  }

  function autocompleteItems(): AutocompleteItem[] {
    if (!s.ac) return [];
    if (s.ac.kind === "agent") {
      return specialistItems(s.specialists ?? [], s.ac.query);
    }
    if (s.ac.kind === "cmd") {
      return [...s.commands, HELP_COMMAND]
        .filter((c) => c.name.startsWith(s.ac!.query))
        .map((c) => ({
          key: c.name,
          label: `#${c.name}`,
          hint: c.summary,
          insert: `#${c.name} `,
          usage: c.usage,
        }));
    }
    if (s.ac.kind === "skill") {
      return s.skills
        .filter((skill) => skill.enabled && skill.name.startsWith(s.ac!.query))
        .slice(0, 10)
        .map((skill) => ({
          key: `skill-${skill.id}`,
          label: `/${skill.name}`,
          hint: skill.description,
          insert: `/${skill.name} `,
          usage: "Skill",
        }));
    }
    const q = s.ac.query;
    const folderItems = s.folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => ({
        key: `fo-${f.id}`,
        label: `@${f.name}/`,
        hint: "folder",
        insert: `@${f.name}/ `,
      }));
    const fileItems = s.files
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({
        key: `fi-${f.id}`,
        label: `@${f.name}`,
        hint: f.mimeType,
        insert: `@${f.name} `,
      }));
    return [...folderItems, ...fileItems].slice(0, 10);
  }

  /** What the "*" menu shows INSTEAD of rows when it has none — "" otherwise,
   * and "" for every other menu (they close when they have nothing, because
   * "no file matches" is not a claim about what this room can do). */
  function autocompleteNote(): string {
    if (!s.ac || s.ac.kind !== "agent") return "";
    return specialistNote(s.specialists, s.specialistsError, s.ac.query);
  }

  function refreshAutocomplete(value: string, caret: number) {
    const tok = tokenAtCaret(value, caret);
    // Opening the "*" menu is the moment its roster has to be current.
    if (tok?.kind === "agent" && s.ac?.kind !== "agent") void refreshSpecialists();
    s.setAc(tok ? { kind: tok.kind, query: tok.query, start: tok.start, index: 0 } : null);
  }

  function insertComposerToken(token: "@" | "#" | "/" | "*") {
    const cur = s.question;
    let next: string;
    let caret: number;
    if (token === "#" || token === "/" || token === "*") {
      const body = cur.replace(/^\s+/, "");
      next = `${token}${body}`;
      caret = 1;
    } else {
      const needsSpace = cur.length > 0 && !/\s$/.test(cur);
      next = `${cur}${needsSpace ? " " : ""}@`;
      caret = next.length;
    }
    s.setQuestion(next);
    // Open the palette in the SAME tick as the text change, exactly the way
    // typing "#"/"/"/"*" does from the box's own onChange — `refreshAutocomplete`
    // is pure over `next`/`caret` and needs no DOM read, so it does not have to
    // wait for a browser round-trip. This used to run only inside the
    // requestAnimationFrame below, alongside the focus/caret-move — which meant
    // the popover's appearance depended on that callback actually firing against
    // a still-mounted `composerRef`. The "*" menu hid the gap: its render gate
    // stays open on `autocompleteNote()` alone (e.g. "Looking up this room's
    // specialists…") even with zero items, so a late or dropped rAF was
    // invisible there. "#" and "/" have no such fallback note — with `s.ac`
    // still unset, `items.length === 0 && !note` is true and NOTHING renders,
    // even though the token was inserted and the chip lit up as "on". Button
    // clicks now reach the same `s.ac` state typing does, unconditionally.
    refreshAutocomplete(next, caret);
    requestAnimationFrame(() => {
      const el = s.composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function acceptAutocomplete(insert: string) {
    const el = s.composerRef.current;
    const caret = el ? el.selectionStart : s.question.length;
    const start = s.ac ? s.ac.start : caret;
    const next = s.question.slice(0, start) + insert + s.question.slice(caret);
    s.setQuestion(next);
    s.setAc(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }

  /** Close the palette AND, with it, an abandoned trigger token — shared by
   * every way a palette can be dismissed without picking a row (Escape, the
   * textarea losing focus). A trigger token was only ever there to open the
   * palette — bare ("*") OR still being filtered ("*fil") — so dismissing it
   * takes the whole attempt with it, and the chip's "is-on" state (which reads
   * straight off `s.question` via `openingSigil`) clears along with it.
   * Checked against the WHOLE current question, not just up to the caret: a
   * first-token trigger with something typed AFTER it ("*file summarize
   * this") is a real message the user finished composing, not an abandoned
   * menu, and must not be swept away. "@" references are different again —
   * they can sit anywhere in an otherwise-finished sentence ("check
   * @lease.pdf then summarize"), so only a bare, un-filtered "@" goes with it.
   * Selecting a row is NOT this path (`acceptAutocomplete` below) — a picked
   * item is a finished choice, not something to undo. */
  function dismissAutocomplete() {
    if (!s.ac) return;
    s.setAc(null);
    const wholeToken = tokenAtCaret(s.question, s.question.length);
    const abandonedTrigger = wholeToken && wholeToken.kind !== "ref";
    const bareRef = s.question.trim() === "@";
    if (abandonedTrigger || bareRef) s.setQuestion("");
  }

  function onComposerKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const items = autocompleteItems();
    // Escape closes an OPEN palette, whether or not it has rows to move
    // through. The "*" menu can be open on an honest note alone ("this room
    // has no specialists"), and a popover the keyboard cannot dismiss is a
    // trap — this used to sit inside the rows-only branch below.
    if (s.ac && e.key === "Escape") {
      // The palette swallows Escape completely — nothing else (viewer
      // close, app-level handlers) may react to the same keypress.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      dismissAutocomplete();
      s.composerRef.current?.focus();
      return;
    }
    if (s.ac && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        let index = s.ac.index;
        for (let n = 0; n < items.length; n += 1) {
          index = (index + 1) % items.length;
          if (!items[index].disabled) break;
        }
        s.setAc({ ...s.ac, index });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        let index = s.ac.index;
        for (let n = 0; n < items.length; n += 1) {
          index = (index - 1 + items.length) % items.length;
          if (!items[index].disabled) break;
        }
        s.setAc({ ...s.ac, index });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = items[Math.min(s.ac.index, items.length - 1)];
        if (!selected.disabled) acceptAutocomplete(selected.insert);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function stopAsk() {
    // Stop must silence speech NOW — and kill the turn's voice epoch so the
    // cancelled ask's endOfTurn (runGuarded's finally) can't speak the
    // leftover sentence buffer, and no in-flight synthesis lands late.
    voice.cancelAll();
    s.setSpeakingMsgId(null);
    // The run belonging to THIS conversation — Stop stops the answer the user
    // is looking at, never a turn running in a chat they have moved away from.
    const id = s.runIdOf(s.activeChatId);
    if (!id) return;
    // Owner replacement #3: Stop reaches the whole tree under the run — a
    // Studio build, a file pass. When it stopped more than the answer itself,
    // SAY which, because those are the ones that would otherwise have finished
    // and put a file in the library after the user had stopped everything.
    // The answer's own "(stopped)" marker covers the plain case, so a single
    // stopped run stays quiet.
    api
      .cancelAsk(id)
      .then((report) => {
        const also = report.stopped.slice(1);
        if (also.length > 0) {
          s.pushToast("info", `Stopped ${also.join(", ")} too.`);
        }
      })
      .catch(() => {});
  }

  async function handleLock() {
    // The lock gate must never keep speaking decrypted room content. Every
    // OTHER lock path is covered too: the autolock call site and the
    // workspace unmount cleanup (effects.ts) both cancel as well.
    voice.cancelAll();
    // EVERY run, not just the one on screen: locking closes the room under all
    // of them, so a turn left running in another conversation would keep
    // writing into a room that is being sealed.
    const running = Object.values(s.runs).map((t) => t.runId);
    if (running.length > 0) {
      for (const id of running) {
        try {
          await api.cancelAsk(id);
        } catch {
          /* ignore — we're locking anyway */
        }
      }
      await new Promise((r) => window.setTimeout(r, 250));
    }
    if (!prefersReducedMotion()) playSealSound();
    try {
      await onLock();
    } catch {
      s.pushToast("error", "Couldn't lock the room — it's still open. Try again.");
    }
  }

  // Context handoff: summarize the chat so far and insert a marker message —
  // `db::recent_messages` then starts every future turn's history from it, so
  // the token-budget bar's next reading reflects the much smaller context.
  async function handoffContext() {
    if (!s.activeChatId || s.asking || s.handoffStarting) return;
    const chatId = s.activeChatId;
    await runGuarded(
      s,
      async () => {
        const marker = await api.handoffContext(chatId);
        s.setMessages(await api.getMessages(chatId));
        if (marker.effects?.usage) s.setChatUsage(chatId, marker.effects.usage);
      },
      {
        begin: () => s.setHandoffStarting(true),
        finish: () => s.setHandoffStarting(false),
      },
    );
  }

  async function regenerate(assistantId: string) {
    const chatId = s.activeChatId;
    if (s.asking || s.handoffStarting || !chatId || sendInFlight.has(chatId)) return;
    await holdingSendLatch(chatId, () => regenerateAccepted(assistantId));
  }

  async function regenerateAccepted(assistantId: string) {
    const chatId = s.activeChatId!;
    const idx = s.messages.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    let userText = "";
    let userId = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (s.messages[i].role === "user") {
        userText = s.messages[i].content;
        userId = s.messages[i].id;
        break;
      }
    }
    if (!userText) return;
    // The answer about to be deleted, held so the press is not a one-way door.
    // Regenerate is pressed hardest on a local 4B, which is exactly where the
    // second attempt can come back worse than the first — and the first is
    // gone by then. Nothing can put it back in the room (a message can be
    // deleted, never re-filed), so what is offered is what is true: a copy.
    const previous = s.messages[idx].content;
    try {
      // The question goes WITH the answer, because `ask`/`run_command` saves it
      // again: leaving it behind put a second copy of it in the transcript, in
      // the history the next turn is answered from, and in Copy chat — one more
      // with every press. Newest first, so an interrupted delete never strands
      // an answer above the question it came from (the editAndResend order).
      await api.deleteMessage(assistantId);
      await api.deleteMessage(userId);
    } catch (e) {
      s.pushToast("error", String(e));
      try {
        s.setMessages(await api.getMessages(chatId));
      } catch {
        /* the failure above is already reported; a second toast about the
           repaint would say nothing the user can act on */
      }
      return;
    }
    s.setMessages(await api.getMessages(chatId));
    // A lost-reply notice is not an answer, so there is nothing worth offering
    // back for one. The offer waits to be dismissed rather than expiring: the
    // moment a user knows they wanted the old answer is after the new one has
    // finished arriving.
    if (lostReplyNotice(previous) === null && splitMarkupBlocks(previous).text.trim()) {
      s.pushToast("info", "Asking again — the previous answer was deleted.", {
        label: "Copy the old one",
        run: () =>
          copyToClipboard(
            s,
            splitMarkupBlocks(previous).text,
            "The previous answer was copied to the clipboard.",
          ),
      });
    }
    // The question is back on screen while the answer is written, exactly as
    // `send` shows it — it was just deleted from the room, and a chat that goes
    // blank until the reply lands reads like the press did nothing.
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: userText,
      sources: [],
      createdAt: "",
      effects: null,
    };
    s.setMessages((m) => [...m, optimistic]);
    // Re-run the original turn the SAME way it was first sent: a #command
    // re-executes as a command (not resent as literal text), and any @-mentioned
    // files are re-attached (parsed back out of the text). The message stores no
    // record of the paperclip, so what rides along is what is on it NOW —
    // which is the rule `askAgainWithRealDetails` already follows, and the
    // reason it gives is the one that matters here too: a retry that carries
    // less evidence than the question it is retrying answers a different
    // question and says nothing about having done so.
    // The scope's TEXT is not re-applied — the saved text already carries
    // whatever the first send prepended, and a second copy of the page would
    // stack on top — but the files it names are not in that text, so they are.
    // A #command is exempt from all of it, exactly as on send: it carries its
    // own arguments and picks its own sources.
    const parsed = parseComposer(userText, s.commands, s.skills, s.files, s.folders);
    if (parsed.command) {
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, userText, askId),
      );
    } else {
      const attachmentIds = [
        ...new Set([
          ...s.attachments.map((f) => f.id),
          ...parsed.refIds,
          ...currentTurnScope().fileIds,
        ]),
      ];
      await askOnce(userText, attachmentIds);
    }
  }

  /** Rewrite one of your own messages and ask again from there. A chat is a
   * straight line, so everything after the edited question goes with it —
   * those answers belong to a question that was never asked. */
  async function editAndResend(messageId: string, newText: string) {
    const chatId = s.activeChatId;
    if (s.asking || s.handoffStarting || !chatId || sendInFlight.has(chatId)) return;
    await holdingSendLatch(chatId, () => editAndResendAccepted(messageId, newText));
  }

  async function editAndResendAccepted(messageId: string, newText: string) {
    const chatId = s.activeChatId!;
    const text = newText.trim();
    if (!text) return;
    const idx = s.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    // Validate BEFORE anything is deleted — a typo'd #command must not cost
    // the user the tail of their conversation.
    //
    // The roster goes in for the same reason it does on send: a rewrite IS a
    // send, and a "*banana" typed here went out unrefused while the identical
    // typo in the composer was stopped — one message, two answers.
    const parsed = parseComposer(
      text,
      s.commands,
      s.skills,
      s.files,
      s.folders,
      s.specialists,
    );
    if (parsed.specialistError) {
      s.pushToast(
        "error",
        specialistErrorMessage(parsed.specialistError, s.specialists),
      );
      return;
    }
    if (parsed.tagConflict) {
      s.pushToast(
        "error",
        "A message can name a specialist (*), a skill (/) or an action (#) — not two of them.",
      );
      return;
    }
    if (parsed.commandError) {
      const names = s.commands.map((c) => `#${c.name}`).join(", ");
      s.pushToast(
        "error",
        `#${parsed.commandError} isn't a command. Try: ${names || "(none available)"}`,
      );
      return;
    }
    if (parsed.skillError) {
      s.pushToast(
        "error",
        `/${parsed.skillError} isn't an enabled skill. Type / to choose from enabled skills.`,
      );
      return;
    }
    // Both first-token tags are hoisted here exactly as they are on send —
    // the backend reads each from the FIRST token, so a rewrite that buries one
    // behind an @reference would run an ordinary turn with nothing saying so.
    const outgoing = parsed.skill
      ? hoistSkill(text, parsed.skill)
      : parsed.specialist
        ? hoistTag(text, parsed.specialist)
        : text;
    // A rewrite IS a send, so it is answered from what the strip promises —
    // this used to go out as bare text, and a question edited under "This page"
    // was answered from the room while the strip above it still said otherwise.
    // Read BEFORE anything is deleted, for the same reason the validation above
    // is: a page that cannot be read must not cost the user the tail of their
    // conversation. Nothing has been removed yet, so a refusal leaves the chat
    // exactly as it was.
    const scoped = await applyScope(outgoing, !!parsed.command);
    if (!scoped.ok) {
      s.pushToast("error", scoped.why);
      return;
    }
    const sending = scoped.text;
    let removed = true;
    try {
      // Newest first, so an interrupted run never leaves an answer stranded
      // above the question it came from.
      for (const m of [...s.messages.slice(idx)].reverse()) {
        await api.deleteMessage(m.id);
      }
    } catch (e) {
      removed = false;
      s.pushToast("error", `Couldn't rewrite this message: ${e}`);
    }
    // Repaint from the room either way, so the transcript on screen matches
    // what is actually stored before anything else happens.
    try {
      s.setMessages(await api.getMessages(chatId));
    } catch (e) {
      s.pushToast("error", `Couldn't reload this chat: ${e}`);
      return;
    }
    // A half-removed tail must not be asked on top of — the old answers would
    // sit between the question and its new reply.
    if (!removed) return;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: sending,
      sources: [],
      createdAt: "",
      effects: null,
    };
    s.setMessages((m) => [...m, optimistic]);
    if (parsed.command) {
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, outgoing, askId),
      );
    } else {
      // The scope's own files ride alongside what the rewrite names, exactly as
      // on send.
      const attachmentIds = [...new Set([...parsed.refIds, ...scoped.fileIds])];
      await askOnce(sending, attachmentIds);
    }
  }

  function copyMessage(m: Message) {
    const clean = splitMarkupBlocks(m.content).text;
    copyToClipboard(s, clean, "Copied to clipboard.");
  }

  /** The whole thread as plain markdown. Copying an answer at a time was the
   * only way to get a conversation out of the room. */
  function copyConversation() {
    if (s.messages.length === 0) {
      s.pushToast("info", "There's nothing in this chat yet.");
      return;
    }
    const title = s.chats.find((c) => c.id === s.activeChatId)?.title ?? "Chat";
    const body = s.messages
      .map((m) => {
        if (m.kind === "handoff") {
          return `**Context summarized, continuing**\n\n${m.content}`;
        }
        // The same speaker names the transcript shows on screen — one
        // definition (markup.speakerName), so the copy and the page can never
        // disagree about who said what.
        const who = speakerName(m.role);
        const text =
          m.role === "assistant" ? splitMarkupBlocks(m.content).text : m.content;
        return `**${who}**\n\n${text}`;
      })
      .join("\n\n---\n\n");
    copyToClipboard(
      s,
      `# ${title}\n\n${body}\n`,
      "The whole chat was copied to the clipboard.",
    );
  }

  function copyAllText() {
    const content = s.openFile?.content;
    if (!content) return;
    const text = readableText(content);
    if (!text) {
      // Reachable: the menu offers this whenever `content.text` is non-empty,
      // and a picture whose OCR found nothing but the prefix has exactly that.
      s.pushToast("info", "There are no words in this file to copy.");
      return;
    }
    copyToClipboard(s, text, "Copied the text to the clipboard.");
  }

  function openSource(name: string) {
    const match = s.files
      .filter((f) => f.name === name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (match) viewFile(match.id);
    else s.pushToast("info", "That file is no longer in the room.");
  }

  function startRename() {
    const c = s.chats.find((c) => c.id === s.activeChatId);
    s.setRenameDraft(c?.title ?? "");
    s.setRenaming(true);
  }

  async function commitRename() {
    const title = s.renameDraft.trim();
    s.setRenaming(false);
    if (!title || !s.activeChatId) return;
    await api.renameChat(s.activeChatId, title);
    s.setChats(await api.listChats());
  }

  async function onComposerPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const file = it.getAsFile();
        if (!file) continue;
        try {
          const b64 = await fileToBase64(file);
          const time = new Date()
            .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            .replace(/:/g, ".");
          const meta = await api.importImageBytes(`Pasted image ${time}.png`, b64);
          s.setFiles(await api.listFiles());
          s.setAttachments((a) => (a.some((f) => f.id === meta.id) ? a : [...a, meta]));
        } catch (err) {
          s.pushToast("error", String(err));
        }
        return;
      }
    }
  }

  async function makeMinutes() {
    if (!s.openFile || s.asking || !s.activeChatId) return;
    const raw = `#minutes @${s.openFile.content.name}`;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: raw,
      sources: [],
      createdAt: "",
      effects: null,
    };
    s.setMessages((m) => [...m, optimistic]);
    const chatId = s.activeChatId;
    await runTurn((askId) =>
      api.runCommand(chatId, "minutes", "", [s.openFile!.id], raw, askId),
    );
  }

  async function saveToRoom(message: Message) {
    if (!s.saveDraft || s.saveDraft.id !== message.id) return;
    // Two files with one name is a trap: the source chip under an answer can
    // only ever open one of them (the newest), so it would show a note the
    // answer did not come from. Save alongside instead of on top.
    const name = uniqueFileName(
      s.saveDraft.name.trim() || "AI note.md",
      s.files.map((f) => f.name),
    );
    try {
      const meta = await api.saveGeneratedFile(name, message.content);
      s.setFiles(await api.listFiles());
      s.setSaveDraft(null);
      s.pushToast("success", `Saved "${meta.name}" into the room.`);
    } catch (e) {
      s.pushToast("error", `Couldn't save this answer: ${e}`);
    }
  }

  function toggleAttach(file: import("../api").FileMeta) {
    s.setAttachments((a) =>
      a.some((f) => f.id === file.id)
        ? a.filter((f) => f.id !== file.id)
        : [...a, file],
    );
  }

  return {
    newChat, removeChat, runTurn, askOnce, askAgainWithRealDetails, send, autocompleteItems,
    autocompleteNote, refreshSpecialists,
    refreshAutocomplete, insertComposerToken, acceptAutocomplete, dismissAutocomplete,
    onComposerKeyDown, stopAsk, handleLock, regenerate, editAndResend,
    copyMessage, copyConversation,
    copyAllText, openSource, startRename, commitRename, onComposerPaste,
    makeMinutes, saveToRoom, toggleAttach, handoffContext,
  };
}
