import { api, memorySuggestion, type Message } from "../api";
import type { BrowserPageSelection, BrowserPageText } from "../apiTypes";
import { parseComposer } from "./composer";
import { runGuarded } from "./guard";
import { splitMarkupBlocks } from "./markup";
import { type ChatScope, pageContext, withPageContext, withSelectionContext, withPreamble } from "./browserScope";
import * as voice from "./voice";
import type { WSState } from "./state";
import { declinedApprovals, sendInFlight, currentTurnScope, PAGE_TEXT_MODE, ParsedComposer, composerValidationMessage, outgoingComposerText, optimisticUserMessage, type ChatActionDeps } from "./chatActions";

export function makeChatCore(s: WSState, deps: ChatActionDeps) {

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

  function completedAssistantText(message: Message | undefined): string | undefined {
    if (message?.role !== "assistant") return undefined;
    return message.effects ? message.content : splitMarkupBlocks(message.content).text;
  }

  async function saveSuggestedMemory(fact: string): Promise<void> {
    try {
      const memory = await api.addMemory(fact);
      s.setMemories(await api.listMemories());
      // addMemory dedups by returning the EXISTING row — only a genuinely new
      // memory earns the toast + Forget undo, or the undo would delete a
      // memory the user saved long ago.
      const isNew = Math.abs(Date.now() - Date.parse(memory.createdAt)) < 10_000;
      if (!isNew) return;
      s.pushToast("success", `Remembered: ${fact}`, {
        label: "Forget",
        run: () => {
          void api.deleteMemory(memory.id).then(async () => {
            s.setMemories(await api.listMemories());
          });
        },
      });
    } catch {
      /* auto-save must never disturb the finished answer */
    }
  }

  function offerMemorySuggestion(chatId: string): void {
    memorySuggestion(chatId)
      .then((suggestion) => {
        if (!(suggestion.worth && suggestion.fact.trim())) return;
        const fact = suggestion.fact.trim();
        // Wave 1b (idea 5): opt-in auto-save replaces the chip entirely.
        if (s.memAutoSaveRef.current) {
          void saveSuggestedMemory(fact);
          return;
        }
        // The card belongs to THIS conversation. If the user has moved on,
        // dropping it is right — it would otherwise appear pinned under a
        // chat that never asked the question.
        if (s.activeChatIdRef.current === chatId) s.setMemSuggestion({ fact });
      })
      .catch(() => {});
  }

  function paintCompletedMessages(chatId: string, messages: Message[]): void {
    if (s.activeChatIdRef.current === chatId) s.setMessages(messages);
    const lastMessage = messages[messages.length - 1];
    // Idea 3: flush the voice's sentence remainder. The fallback text covers
    // external CLI engines (they emit no ask-delta — the pipeline was fed
    // nothing, so endOfTurn speaks the persisted answer instead).
    voice.endOfTurn(completedAssistantText(lastMessage));
    if (lastMessage?.role === "assistant" && lastMessage.content.trim()) {
      offerMemorySuggestion(chatId);
    }
  }

  function retainEditedFiles(messages: Message[]): void {
    const edited = [...s.editedRef.current];
    if (edited.length === 0) return;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) s.setUndoByMsg((undo) => ({ ...undo, [lastAssistant.id]: edited }));
  }

  async function refreshAfterTurn(chatId: string): Promise<void> {
    const messages = await api.getMessages(chatId);
    // Only paint the conversation the user is actually looking at. Switching
    // chats mid-answer used to repaint the OLD transcript under the NEW
    // header; the answer is filed correctly either way, and the chat-switch
    // effect loads the right messages.
    paintCompletedMessages(chatId, messages);
    retainEditedFiles(messages);
    s.setChats(await api.listChats());
    api.listFiles().then(s.setFiles).catch(() => {});
    api.listMemories().then(s.setMemories).catch(() => {});
  }

  function finishRunCleanup(chatId: string): void {
    // The run is over: its registration and its whole live overlay go
    // together, in this chat's slot alone. No other conversation's in-flight
    // turn is touched.
    s.endRun(chatId);
    // Wave 2 (Idea 6): the run is over (finished OR stopped — this is
    // runGuarded's `finally`). Decline any diff-preview card still queued: the
    // tools/call task that awaits it is gone, so applying now would mutate a
    // turn that no longer exists (second-pass addendum).
    s.setEditApprovals((approvals) => {
      for (const approval of approvals) {
        if (declinedApprovals.has(approval.id)) continue;
        declinedApprovals.add(approval.id);
        api.resolveEditApproval(approval.id, "deny").catch(() => {});
      }
      return [];
    });
  }

  async function finishTurn(chatId: string): Promise<void> {
    // EVERY reload below can fail (a locked/compacting room, a dropped IPC).
    // None of them may strand the composer on "Stop": the busy flags are
    // lowered in this function's own `finally`, whatever happens.
    try {
      await refreshAfterTurn(chatId);
    } catch (error) {
      s.pushToast("error", `The answer finished but this chat couldn't be reloaded: ${error}`);
    } finally {
      finishRunCleanup(chatId);
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
      finish: () => finishTurn(chatId),
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
    if (!sendableChatId(raw, chatId)) return;
    await holdingSendLatch(chatId, () => sendAccepted(raw));
  }

  function sendableChatId(raw: string, chatId: string | null): chatId is string {
    if (!raw) return false;
    if (s.asking || s.handoffStarting) return false;
    if (!chatId || sendInFlight.has(chatId)) return false;
    return true;
  }

  function showHelpIfRequested(raw: string): boolean {
    if (!/^#help(\s|$)/i.test(raw)) return false;
    s.setAc(null);
    s.setShowHelp(true);
    // Only a bare "#help" is just a request for the list. "#help how do I…"
    // still opens it, but the question stays in the box — throwing away what
    // someone typed with no way to get it back is never the right answer.
    if (/^#help\s*$/i.test(raw)) s.setQuestion("");
    return true;
  }

  async function sendParsedTurn(
    raw: string,
    sending: string,
    parsed: ParsedComposer,
    scopedFileIds: readonly string[],
  ): Promise<void> {
    const chatId = s.activeChatId!;
    if (parsed.command) {
      s.setAttachments([]);
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, raw, askId),
      );
      return;
    }
    // The scope's own files ride ALONGSIDE what is pinned, never instead of
    // it: "“Portfolio map” + 2 attached" is what the strip says it will do,
    // and dropping a source someone deliberately pinned would be a change
    // they never asked for and could not see.
    const attachmentIds = [
      ...new Set([
        ...s.attachments.map((file) => file.id),
        ...parsed.refIds,
        ...scopedFileIds,
      ]),
    ];
    s.setAttachments([]);
    await askOnce(sending, attachmentIds);
  }

  async function sendAccepted(raw: string) {
    if (showHelpIfRequested(raw)) return;
    const parsed = parseComposer(
      raw,
      s.commands,
      s.skills,
      s.files,
      s.folders,
      s.specialists,
    );
    const validationMessage = composerValidationMessage(parsed, s.commands, s.specialists);
    if (validationMessage) {
      s.pushToast("error", validationMessage);
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
    const outgoing = outgoingComposerText(raw, parsed);
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
    s.setMessages((messages) => [...messages, optimisticUserMessage(sending)]);
    await sendParsedTurn(raw, sending, parsed, scoped.fileIds);
  }
  return { viewFile, openOllamaApp, downloadModel, refreshAi, playSealSound, newChat, removeChat, completedAssistantText, saveSuggestedMemory, offerMemorySuggestion, paintCompletedMessages, retainEditedFiles, refreshAfterTurn, finishRunCleanup, finishTurn, runTurn, askOnce, askAgainWithRealDetails, selectedPassage, scopedQuestion, applyScope, holdingSendLatch, send, sendableChatId, showHelpIfRequested, sendParsedTurn, sendAccepted };
}
export type ChatCore = ReturnType<typeof makeChatCore>;
