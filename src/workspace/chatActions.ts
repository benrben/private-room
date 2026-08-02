import {
  ClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api, FileTarget, memorySuggestion, Message } from "../api";
import {
  fileToBase64,
  hoistSkill,
  parseComposer,
  tokenAtCaret,
  uniqueFileName,
} from "./composer";
import { runGuarded } from "./guard";
import { splitMarkupBlocks } from "./markup";
import { HELP_COMMAND } from "./constants";
import * as voice from "./voice";
import { WSState } from "./state";

/** The chat the UI is showing RIGHT NOW. A turn's callbacks close over the `s`
 * of the render that started it, so they cannot ask which conversation is on
 * screen minutes later — and painting a finished turn's messages into whatever
 * chat the user has since switched to is exactly the bug this prevents.
 * `makeChatActions` runs on every Workspace render, which keeps this current. */
const liveChat: { id: string | null } = { id: null };

/** Edit-approval ids already declined by a turn teardown. `setEditApprovals`'
 * updater is allowed to run more than once for one update (StrictMode, a
 * re-entrant render), so the decline it fires has to be idempotent. */
const declinedApprovals = new Set<string>();

/** Chat sessions + the AI-turn flow + the composer's #, @, and / autocomplete. Cross-hook
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
  liveChat.id = s.activeChatId;

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
        s.askIdRef.current = askId;
        s.setAsking(true);
        s.setAskPrivacy(null);
        s.setStreamText("");
        s.setSteps([]);
        s.setLane("");
        s.setAgentPlan(null);
        s.setActiveAgent(null);
        s.setAgentSteps({});
        s.setMemSuggestion(null);
        s.editedRef.current = new Set();
        declinedApprovals.clear();
        // Idea 3: a new turn silences the old answer and opens a fresh voice
        // epoch (stale synthesis/decodes can never schedule audio into it).
        voice.beginTurn();
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
        s.askIdRef.current = null;
        // EVERY reload below can fail (a locked/compacting room, a dropped
        // IPC). None of them may strand the composer on "Stop": the busy flags
        // are lowered in this function's own `finally`, whatever happens.
        try {
          const msgs = await api.getMessages(chatId);
          // Only paint the conversation the user is actually looking at. Switching
          // chats mid-answer used to repaint the OLD transcript under the NEW
          // header; the answer is filed correctly either way, and the chat-switch
          // effect loads the right messages.
          if (liveChat.id === chatId) s.setMessages(msgs);
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
                } else if (liveChat.id === chatId) {
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
          s.setAsking(false);
          s.setStreamText("");
          s.setSteps([]);
          s.setLane("");
          s.setAgentPlan(null);
          s.setActiveAgent(null);
          s.setAgentSteps({});
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
    await runTurn((askId) => api.ask(chatId, q, attachmentIds, askId, privacyBypass));
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
    const attachmentIds = [
      ...new Set([...s.attachments.map((f) => f.id), ...parsed.refIds]),
    ];
    await askOnce(lastUser.content, attachmentIds, true);
  }

  /** `text` overrides the composer draft (hands-free dictation sends the
   * transcript directly — state updates would race a same-tick send). */
  async function send(text?: string) {
    // Sending is always a click/Enter/dictation gesture — the one reliable
    // moment to unlock the AudioContext for this turn's auto-speak (same
    // "must be first in the gesture" doctrine as acquireMic).
    voice.ensureUnlocked();
    const raw = (text ?? s.question).trim();
    if (!raw || s.asking || !s.activeChatId) return;
    if (/^#help(\s|$)/i.test(raw)) {
      s.setAc(null);
      s.setShowHelp(true);
      // Only a bare "#help" is just a request for the list. "#help how do I…"
      // still opens it, but the question stays in the box — throwing away what
      // someone typed with no way to get it back is never the right answer.
      if (/^#help\s*$/i.test(raw)) s.setQuestion("");
      return;
    }
    const parsed = parseComposer(raw, s.commands, s.skills, s.files, s.folders);
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
    const outgoing = parsed.skill ? hoistSkill(raw, parsed.skill) : raw;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: outgoing,
      sources: [],
      createdAt: "",
      effects: null,
    };
    s.setMessages((m) => [...m, optimistic]);
    const chatId = s.activeChatId;
    if (parsed.command) {
      s.setAttachments([]);
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, raw, askId),
      );
    } else {
      const attachmentIds = [
        ...new Set([...s.attachments.map((f) => f.id), ...parsed.refIds]),
      ];
      s.setAttachments([]);
      await askOnce(outgoing, attachmentIds);
    }
  }

  // ---- "#"/"@"/"/" autocomplete ----

  function autocompleteItems(): {
    key: string;
    label: string;
    hint: string;
    insert: string;
    usage?: string;
  }[] {
    if (!s.ac) return [];
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

  function refreshAutocomplete(value: string, caret: number) {
    const tok = tokenAtCaret(value, caret);
    s.setAc(tok ? { kind: tok.kind, query: tok.query, start: tok.start, index: 0 } : null);
  }

  function insertComposerToken(token: "@" | "#" | "/") {
    const cur = s.question;
    let next: string;
    let caret: number;
    if (token === "#" || token === "/") {
      const body = cur.replace(/^\s+/, "");
      next = `${token}${body}`;
      caret = 1;
    } else {
      const needsSpace = cur.length > 0 && !/\s$/.test(cur);
      next = `${cur}${needsSpace ? " " : ""}@`;
      caret = next.length;
    }
    s.setQuestion(next);
    requestAnimationFrame(() => {
      const el = s.composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
        refreshAutocomplete(next, caret);
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

  function onComposerKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const items = autocompleteItems();
    if (s.ac && items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        s.setAc({ ...s.ac, index: (s.ac.index + 1) % items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        s.setAc({ ...s.ac, index: (s.ac.index - 1 + items.length) % items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptAutocomplete(items[Math.min(s.ac.index, items.length - 1)].insert);
        return;
      }
      if (e.key === "Escape") {
        // The palette swallows Escape completely — nothing else (viewer
        // close, app-level handlers) may react to the same keypress.
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        s.setAc(null);
        // A bare trigger token was only there to open the palette; closing
        // the palette takes it with it so the composer is back where it was.
        if (["#", "@", "/"].includes(s.question.trim()))
          s.setQuestion("");
        s.composerRef.current?.focus();
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
    const id = s.askIdRef.current;
    if (id) api.cancelAsk(id).catch(() => {});
  }

  async function handleLock() {
    // The lock gate must never keep speaking decrypted room content. Every
    // OTHER lock path is covered too: the autolock call site and the
    // workspace unmount cleanup (effects.ts) both cancel as well.
    voice.cancelAll();
    if (s.askingRef.current && s.askIdRef.current) {
      try {
        await api.cancelAsk(s.askIdRef.current);
      } catch {
        /* ignore — we're locking anyway */
      }
      await new Promise((r) => window.setTimeout(r, 250));
    }
    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!reduced) playSealSound();
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
        if (marker.effects?.usage) s.setTokenUsage(marker.effects.usage);
      },
      {
        begin: () => s.setHandoffStarting(true),
        finish: () => s.setHandoffStarting(false),
      },
    );
  }

  async function regenerate(assistantId: string) {
    if (s.asking || !s.activeChatId) return;
    const chatId = s.activeChatId;
    const idx = s.messages.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    let userText = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (s.messages[i].role === "user") {
        userText = s.messages[i].content;
        break;
      }
    }
    if (!userText) return;
    try {
      await api.deleteMessage(assistantId);
    } catch (e) {
      s.pushToast("error", String(e));
      return;
    }
    s.setMessages(await api.getMessages(chatId));
    // Re-run the original turn the SAME way it was first sent: a #command
    // re-executes as a command (not resent as literal text), and any @-mentioned
    // files are re-attached (parsed back out of the text). Paperclip-only
    // attachments aren't stored on the message, so those can't be recovered here.
    const parsed = parseComposer(userText, s.commands, s.skills, s.files, s.folders);
    if (parsed.command) {
      await runTurn((askId) =>
        api.runCommand(chatId, parsed.command!, parsed.args, parsed.refIds, userText, askId),
      );
    } else {
      await askOnce(userText, parsed.refIds);
    }
  }

  /** Rewrite one of your own messages and ask again from there. A chat is a
   * straight line, so everything after the edited question goes with it —
   * those answers belong to a question that was never asked. */
  async function editAndResend(messageId: string, newText: string) {
    if (s.asking || !s.activeChatId) return;
    const chatId = s.activeChatId;
    const text = newText.trim();
    if (!text) return;
    const idx = s.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    // Validate BEFORE anything is deleted — a typo'd #command must not cost
    // the user the tail of their conversation.
    const parsed = parseComposer(text, s.commands, s.skills, s.files, s.folders);
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
    const outgoing = parsed.skill ? hoistSkill(text, parsed.skill) : text;
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
      content: outgoing,
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
      await askOnce(outgoing, parsed.refIds);
    }
  }

  function copyMessage(m: Message) {
    const clean = splitMarkupBlocks(m.content).text;
    navigator.clipboard.writeText(clean).then(
      () => s.pushToast("success", "Copied to clipboard."),
      (e) => s.pushToast("error", String(e)),
    );
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
        const who = m.role === "assistant" ? "Room AI" : "You";
        const text =
          m.role === "assistant" ? splitMarkupBlocks(m.content).text : m.content;
        return `**${who}**\n\n${text}`;
      })
      .join("\n\n---\n\n");
    navigator.clipboard.writeText(`# ${title}\n\n${body}\n`).then(
      () => s.pushToast("success", "The whole chat was copied to the clipboard."),
      (e) => s.pushToast("error", String(e)),
    );
  }

  function copyAllText() {
    const text = s.openFile?.content.text;
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => s.pushToast("success", "Copied all text to clipboard."),
      (e) => s.pushToast("error", String(e)),
    );
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
    refreshAutocomplete, insertComposerToken, acceptAutocomplete,
    onComposerKeyDown, stopAsk, handleLock, regenerate, editAndResend,
    copyMessage, copyConversation,
    copyAllText, openSource, startRename, commitRename, onComposerPaste,
    makeMinutes, saveToRoom, toggleAttach, handoffContext,
  };
}
