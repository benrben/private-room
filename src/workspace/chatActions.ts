import {
  ClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api, FileTarget, memorySuggestion, Message } from "../api";
import { fileToBase64, parseComposer, tokenAtCaret } from "./composer";
import { runGuarded } from "./guard";
import { splitMarkupBlocks } from "./markup";
import { HELP_COMMAND } from "./constants";
import { WSState } from "./state";

/** Chat sessions + the AI-turn flow + the composer's #/@ autocomplete. Cross-hook
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
    const c = await api.createChat();
    s.setChats(await api.listChats());
    s.setActiveChatId(c.id);
  }

  async function removeChat(id: string) {
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
  }

  async function runTurn(run: (askId: string) => Promise<unknown>) {
    if (!s.activeChatId) return;
    const chatId = s.activeChatId;
    const askId = crypto.randomUUID();
    await runGuarded(s, () => run(askId), {
      begin: () => {
        s.askIdRef.current = askId;
        s.setAsking(true);
        s.setStreamText("");
        s.setSteps([]);
        s.setLane("");
        s.setMemSuggestion(null);
        s.editedRef.current = new Set();
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
        const msgs = await api.getMessages(chatId);
        s.setMessages(msgs);
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.content.trim()) {
          memorySuggestion(chatId)
            .then((sug) => {
              if (sug.worth && sug.fact.trim()) s.setMemSuggestion({ fact: sug.fact.trim() });
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
        api.listFiles().then(s.setFiles);
        api.listMemories().then(s.setMemories);
        s.setAsking(false);
        s.setStreamText("");
        s.setSteps([]);
        s.setLane("");
      },
    });
  }

  async function askOnce(q: string, attachmentIds: string[]) {
    const chatId = s.activeChatId;
    if (!chatId) return;
    await runTurn((askId) => api.ask(chatId, q, attachmentIds, askId));
  }

  async function send() {
    const raw = s.question.trim();
    if (!raw || s.asking || !s.activeChatId) return;
    if (/^#help(\s|$)/i.test(raw)) {
      s.setQuestion("");
      s.setAc(null);
      s.setShowHelp(true);
      return;
    }
    const parsed = parseComposer(raw, s.commands, s.files, s.folders);
    if (parsed.commandError) {
      const names = s.commands.map((c) => `#${c.name}`).join(", ");
      s.pushToast(
        "error",
        `#${parsed.commandError} isn't a command. Try: ${names || "(none available)"}`,
      );
      return;
    }
    s.setQuestion("");
    s.setAc(null);
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
      await askOnce(raw, attachmentIds);
    }
  }

  // ---- "#"/"@" autocomplete ----

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

  function insertComposerToken(token: "@" | "#") {
    const cur = s.question;
    let next: string;
    let caret: number;
    if (token === "#") {
      const body = cur.replace(/^\s+/, "");
      next = `#${body}`;
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
        if (s.question.trim() === "#" || s.question.trim() === "@")
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
    const id = s.askIdRef.current;
    if (id) api.cancelAsk(id).catch(() => {});
  }

  async function handleLock() {
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

  async function regenerate(assistantId: string) {
    if (s.asking || !s.activeChatId) return;
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
    s.setMessages(await api.getMessages(s.activeChatId));
    await askOnce(userText, []);
  }

  function copyMessage(m: Message) {
    const clean = splitMarkupBlocks(m.content).text;
    navigator.clipboard.writeText(clean).then(
      () => s.pushToast("success", "Copied to clipboard."),
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
    const name = s.saveDraft.name.trim() || "AI note.md";
    const meta = await api.saveGeneratedFile(name, message.content);
    s.setFiles(await api.listFiles());
    s.setSaveDraft(null);
    s.pushToast("success", `Saved "${meta.name}" into the room.`);
  }

  function toggleAttach(file: import("../api").FileMeta) {
    s.setAttachments((a) =>
      a.some((f) => f.id === file.id)
        ? a.filter((f) => f.id !== file.id)
        : [...a, file],
    );
  }

  return {
    newChat, removeChat, runTurn, askOnce, send, autocompleteItems,
    refreshAutocomplete, insertComposerToken, acceptAutocomplete,
    onComposerKeyDown, stopAsk, handleLock, regenerate, copyMessage,
    copyAllText, openSource, startRename, commitRename, onComposerPaste,
    makeMinutes, saveToRoom, toggleAttach,
  };
}
