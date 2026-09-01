import type { ClipboardEvent } from "react";
import { api, type Message } from "../api";
import { fileToBase64, parseComposer, uniqueFileName } from "./composer";
import { runGuarded } from "./guard";
import { prefersReducedMotion } from "../rooms/helpers";
import { lostReplyNotice, speakerName, splitMarkupBlocks } from "./markup";
import * as voice from "./voice";
import type { WSState } from "./state";
import { sendInFlight, currentTurnScope, copyToClipboard, ParsedComposer, readableText, composerValidationMessage, outgoingComposerText, optimisticUserMessage } from "./chatActions";
import type { ComposerActions } from "./chatComposerActions";

export function makeChatTail(s: WSState, actions: ComposerActions, onLock: () => void | Promise<void>) {
  const { viewFile, playSealSound, runTurn, askOnce, applyScope, holdingSendLatch } = actions;


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

  function precedingUserMessage(index: number): { id: string; text: string } | null {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const message = s.messages[cursor];
      if (message.role === "user") return { id: message.id, text: message.content };
    }
    return null;
  }

  async function reloadAfterRegenerateFailure(chatId: string): Promise<void> {
    try {
      s.setMessages(await api.getMessages(chatId));
    } catch {
      /* the delete failure is already reported; a second toast would say
         nothing the user can act on */
    }
  }

  async function deleteRegeneratedPair(
    chatId: string,
    assistantId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      // The question goes WITH the answer, because `ask`/`run_command` saves
      // it again: leaving it behind put a second copy of it in the transcript,
      // in the history the next turn is answered from, and in Copy chat — one
      // more with every press. Newest first, so an interrupted delete never
      // strands an answer above the question it came from.
      await api.deleteMessage(assistantId);
      await api.deleteMessage(userId);
      return true;
    } catch (error) {
      s.pushToast("error", String(error));
      await reloadAfterRegenerateFailure(chatId);
      return false;
    }
  }

  function offerPreviousReply(previous: string): void {
    const reply = splitMarkupBlocks(previous).text;
    if (lostReplyNotice(previous) !== null || !reply.trim()) return;
    // A lost-reply notice is not an answer, so there is nothing worth offering
    // back for one. The offer waits to be dismissed rather than expiring: the
    // moment a user knows they wanted the old answer is after the new one has
    // finished arriving.
    s.pushToast("info", "Asking again — the previous answer was deleted.", {
      label: "Copy the old one",
      run: () => copyToClipboard(s, reply, "The previous answer was copied to the clipboard."),
    });
  }

  async function resendRegeneratedTurn(chatId: string, userText: string): Promise<void> {
    // Re-run the original turn the SAME way it was first sent: a #command
    // re-executes as a command (not resent as literal text), and any @-mentioned
    // files are re-attached (parsed back out of the text). The message stores no
    // record of the paperclip, so what rides along is what is on it NOW.
    const parsed = parseComposer(userText, s.commands, s.skills, s.files, s.folders);
    if (parsed.command) {
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, userText, askId),
      );
      return;
    }
    // The scope's TEXT is not re-applied — the saved text already carries
    // whatever the first send prepended, and a second copy of the page would
    // stack on top — but the files it names are not in that text, so they are.
    const attachmentIds = [
      ...new Set([
        ...s.attachments.map((file) => file.id),
        ...parsed.refIds,
        ...currentTurnScope().fileIds,
      ]),
    ];
    await askOnce(userText, attachmentIds);
  }

  async function regenerateAccepted(assistantId: string) {
    const chatId = s.activeChatId!;
    const idx = s.messages.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    const user = precedingUserMessage(idx);
    if (user === null || !user.text) return;
    // The answer about to be deleted, held so the press is not a one-way door.
    // Regenerate is pressed hardest on a local 4B, which is exactly where the
    // second attempt can come back worse than the first — and the first is
    // gone by then. Nothing can put it back in the room (a message can be
    // deleted, never re-filed), so what is offered is what is true: a copy.
    const previous = s.messages[idx].content;
    if (!await deleteRegeneratedPair(chatId, assistantId, user.id)) return;
    s.setMessages(await api.getMessages(chatId));
    offerPreviousReply(previous);
    // The question is back on screen while the answer is written, exactly as
    // `send` shows it — it was just deleted from the room, and a chat that goes
    // blank until the reply lands reads like the press did nothing.
    s.setMessages((messages) => [...messages, optimisticUserMessage(user.text)]);
    await resendRegeneratedTurn(chatId, user.text);
  }

  /** Rewrite one of your own messages and ask again from there. A chat is a
   * straight line, so everything after the edited question goes with it —
   * those answers belong to a question that was never asked. */
  async function editAndResend(messageId: string, newText: string) {
    const chatId = s.activeChatId;
    if (s.asking || s.handoffStarting || !chatId || sendInFlight.has(chatId)) return;
    await holdingSendLatch(chatId, () => editAndResendAccepted(messageId, newText));
  }

  async function removeEditedTail(chatId: string, index: number): Promise<boolean> {
    let removed = true;
    try {
      // Newest first, so an interrupted run never leaves an answer stranded
      // above the question it came from.
      for (const message of [...s.messages.slice(index)].reverse()) {
        await api.deleteMessage(message.id);
      }
    } catch (error) {
      removed = false;
      s.pushToast("error", `Couldn't rewrite this message: ${error}`);
    }
    // Repaint from the room either way, so the transcript on screen matches
    // what is actually stored before anything else happens.
    try {
      s.setMessages(await api.getMessages(chatId));
    } catch (error) {
      s.pushToast("error", `Couldn't reload this chat: ${error}`);
      return false;
    }
    return removed;
  }

  async function sendEditedTurn(
    chatId: string,
    outgoing: string,
    sending: string,
    parsed: ParsedComposer,
    scopedFileIds: readonly string[],
  ): Promise<void> {
    if (parsed.command) {
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, outgoing, askId),
      );
      return;
    }
    // The scope's own files ride alongside what the rewrite names, exactly as
    // on send.
    const attachmentIds = [...new Set([...parsed.refIds, ...scopedFileIds])];
    await askOnce(sending, attachmentIds);
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
    const validationMessage = composerValidationMessage(parsed, s.commands, s.specialists);
    if (validationMessage) {
      s.pushToast("error", validationMessage);
      return;
    }
    // Both first-token tags are hoisted here exactly as they are on send —
    // the backend reads each from the FIRST token, so a rewrite that buries one
    // behind an @reference would run an ordinary turn with nothing saying so.
    const outgoing = outgoingComposerText(text, parsed);
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
    const removed = await removeEditedTail(chatId, idx);
    // A half-removed tail must not be asked on top of — the old answers would
    // sit between the question and its new reply.
    if (!removed) return;
    s.setMessages((messages) => [...messages, optimisticUserMessage(sending)]);
    await sendEditedTurn(chatId, outgoing, sending, parsed, scoped.fileIds);
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
  return { ...actions, stopAsk, handleLock, handoffContext, regenerate, precedingUserMessage, reloadAfterRegenerateFailure, deleteRegeneratedPair, offerPreviousReply, resendRegeneratedTurn, regenerateAccepted, editAndResend, removeEditedTail, sendEditedTurn, editAndResendAccepted, copyMessage, copyConversation, copyAllText, openSource, startRename, commitRename, onComposerPaste, makeMinutes, saveToRoom, toggleAttach };
}
