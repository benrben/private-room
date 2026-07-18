import { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  AnnotationPayload,
  api,
  engineModelLabel,
  ExternalModelInfo,
  frontPage,
  frontPageSuggestions,
  McpApproveRequest,
  McpServerStatus,
  RoomInfo,
} from "../api";
import { runGuarded, tryToast } from "./guard";
import { FlatResult } from "./types";
import { WSState } from "./state";

/** Memory, MCP approvals, front page, search, panes, and model-switch handlers.
 * Cross-hook: `viewFile` (files) is threaded in for submitLink/search. */
export function makeMiscActions(
  s: WSState,
  info: RoomInfo,
  deps: { viewFile: (id: string, target?: import("../api").FileTarget) => Promise<void> },
) {
  const { viewFile } = deps;

  function refreshWebAccess() {
    api
      .getSetting("web_provider")
      .then((v) => s.setWebOn(v === "duckduckgo" || v === "searxng" || v === "brave"))
      .catch(() => {});
  }

  function refreshAutolock() {
    api
      .getSetting("autolock_minutes")
      .then((v) => {
        s.autolockRef.current = v ?? "15";
      })
      .catch(() => {});
  }

  async function dismissSyncWarn() {
    s.setShowSyncWarn(false);
    try {
      await api.setSetting("hlt6_sync_dismissed", "1");
    } catch {
      /* best-effort; banner is already hidden for this session */
    }
  }

  function connectedTools(statuses: McpServerStatus[]): string[] {
    return statuses
      .filter((st) => st.status === "connected")
      .flatMap((st) => st.tools.map((t) => `${st.name}: ${t}`));
  }

  async function approveMcp() {
    const pending = info.pendingMcp;
    if (!pending || s.approvingMcp) return;
    s.setApprovingMcp(true);
    try {
      const statuses = await api.approveMcp(pending.fingerprint);
      s.setMcpTools(connectedTools(statuses));
      s.setMcpDialogDismissed(true);
      s.pushToast("success", "This room's tools are now allowed on this Mac.");
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      s.setApprovingMcp(false);
    }
  }

  function keepMcpOff() {
    s.setMcpDialogDismissed(true);
  }

  async function submitLink() {
    const url = s.linkUrl.trim();
    if (!url || s.importingLink) return;
    await runGuarded(
      s,
      async () => {
        const meta = await api.importLink(url);
        s.setFiles(await api.listFiles());
        s.setShowAddLink(false);
        s.setLinkUrl("");
        s.pushToast("success", `Saved "${meta.name}" into the room.`);
        viewFile(meta.id);
      },
      {
        begin: () => s.setImportingLink(true),
        finish: () => s.setImportingLink(false),
      },
    );
  }

  function loadFrontPage(withSuggestions: boolean) {
    frontPage()
      .then((page) => {
        s.setFp(page);
        s.setFpSuggestions((cur) => (cur.length ? cur : page.suggestions ?? []));
      })
      .catch(() => {});
    if (withSuggestions) {
      frontPageSuggestions()
        .then((sug) => {
          if (sug.length) s.setFpSuggestions(sug);
        })
        .catch(() => {});
    }
  }

  async function saveSuggestedMemory() {
    const fact = s.memSuggestion?.fact;
    if (!fact) return;
    s.setMemSuggestion(null);
    await tryToast(
      s,
      () => api.addMemory(fact),
      async () => {
        s.setMemories(await api.listMemories());
        s.pushToast("success", "Saved to memory.");
      },
    );
  }

  function copyReceipt(a: AnnotationPayload) {
    const parts = [`"${a.quote}"`, `— ${a.name ?? "this room"}`];
    if (a.page) parts.push(`p. ${a.page}`);
    else if (a.sheet) parts.push(a.sheet);
    else if (a.range) parts.push(a.range);
    navigator.clipboard.writeText(parts.join("  ")).then(
      () => s.pushToast("success", "Receipt copied."),
      (e) => s.pushToast("error", String(e)),
    );
  }

  function playSealSound() {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(420, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(170, ctx.currentTime + 0.34);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.44);
      osc.onended = () => ctx.close().catch(() => {});
    } catch {
      /* no audio — the visual seal carries the moment */
    }
  }

  async function addMemory() {
    const content = s.memoryDraft.trim();
    if (!content) return;
    // The draft is only cleared once the memory is actually stored, so a failed
    // save leaves the text where the user can retry it.
    await tryToast(
      s,
      () => api.addMemory(content),
      async () => {
        s.setMemories(await api.listMemories());
        s.setMemoryDraft("");
      },
    );
  }

  async function saveMemoryEdit() {
    if (!s.editingMemory) return;
    const { id, content } = s.editingMemory;
    const trimmed = content.trim();
    s.setEditingMemory(null);
    if (!trimmed) return;
    await tryToast(
      s,
      () => api.updateMemory(id, trimmed),
      async () => s.setMemories(await api.listMemories()),
    );
  }

  function activateResult(r: FlatResult) {
    if (r.kind === "file") {
      viewFile(r.id, { find: r.snippet });
    } else if (r.kind === "message") {
      s.setActiveChatId(r.chatId);
      const mid = r.messageId;
      window.setTimeout(() => {
        document
          .getElementById(`msg-${mid}`)
          ?.scrollIntoView({ block: "center" });
      }, 120);
    } else {
      s.setShowMemory(true);
    }
    s.setShowSearch(false);
  }

  function resolveMcpApproval(
    req: McpApproveRequest,
    decision: "once" | "always" | "deny",
  ) {
    api.resolveMcpCall(req.id, decision).catch(() => {});
    s.setMcpApprovals((q) => q.filter((r) => r.id !== req.id));
  }

  function revealMemory() {
    s.setShowMemory(true);
    s.setShowMemoryIntro(false);
    try {
      localStorage.setItem(`memoryIntroSeen:${info.name}`, "1");
    } catch {
      /* non-fatal */
    }
    window.setTimeout(() => {
      s.memoryHeadRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 30);
  }

  async function changeModel(value: string) {
    s.userPickedModelRef.current = true;
    s.setModel(value);
    await api.setSetting("model", value);
  }

  function engineLabelOf(m: string): string {
    return engineModelLabel(m, s.engineModels);
  }

  /** Cache a cloud engine's fetched model list (Cloud picker second level) so
   * the model pill/toasts can show friendly names without re-fetching. */
  function recordEngineModels(engine: string, models: ExternalModelInfo[]) {
    s.setEngineModels((prev) => ({ ...prev, [engine]: models }));
  }

  // ---- ADD-3: two-step delete ----
  function askConfirm(key: string) {
    window.clearTimeout(s.confirmTimer.current);
    s.setConfirmDelete(key);
    s.confirmTimer.current = window.setTimeout(
      () => s.setConfirmDelete((k) => (k === key ? null : k)),
      3000,
    );
  }

  function cancelConfirm() {
    window.clearTimeout(s.confirmTimer.current);
    s.setConfirmDelete(null);
  }

  /** Start dragging a pane divider. `edge` says which pane the divider sizes. */
  function startPaneResize(edge: "sidebar" | "chat", e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = edge === "sidebar" ? s.sidebarW : s.chatW;
    document.body.classList.add("resizing-col");
    function onMove(ev: MouseEvent) {
      const delta = edge === "sidebar" ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.max(220, Math.min(560, startW + delta));
      if (edge === "sidebar") s.setSidebarW(next);
      else s.setChatW(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-col");
      s.setSidebarW((sw) => {
        s.setChatW((cw) => {
          try {
            localStorage.setItem(s.paneKey, JSON.stringify({ sidebar: sw, chat: cw }));
          } catch {
            /* storage full/unavailable — non-fatal */
          }
          return cw;
        });
        return sw;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ADD-6: flatten grouped search results for arrow-key navigation.
  function searchFlat(): FlatResult[] {
    const flat: FlatResult[] = [];
    const sr = s.searchResults;
    if (sr) {
      sr.files.forEach((f) =>
        flat.push({ kind: "file", id: f.id, name: f.name, snippet: f.snippet }),
      );
      sr.messages.forEach((m) =>
        flat.push({
          kind: "message",
          chatId: m.chatId,
          messageId: m.messageId,
          snippet: m.snippet,
        }),
      );
      sr.memories.forEach((m) =>
        flat.push({ kind: "memory", id: m.id, snippet: m.snippet }),
      );
    }
    return flat;
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    const flat = searchFlat();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      s.setSearchSel((sel) => Math.min(sel + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      s.setSearchSel((sel) => Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = flat[s.searchSel];
      if (r) activateResult(r);
    }
  }

  return {
    refreshWebAccess, refreshAutolock, dismissSyncWarn, connectedTools,
    approveMcp, keepMcpOff, submitLink, loadFrontPage, saveSuggestedMemory,
    copyReceipt, playSealSound, addMemory, saveMemoryEdit, activateResult,
    resolveMcpApproval, revealMemory, changeModel, engineLabelOf,
    recordEngineModels,
    askConfirm, cancelConfirm, startPaneResize, searchFlat, onSearchKey,
  };
}
