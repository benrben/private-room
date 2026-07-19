import {
  AnnotationPayload,
  api,
  EditApproveRequest,
  engineModelLabel,
  ExternalModelInfo,
  frontPage,
  frontPageSuggestions,
  McpApproveRequest,
  McpServerStatus,
  RoomInfo,
} from "../api";
import { tryToast } from "./guard";
import { FlatResult } from "./types";
import { WSState } from "./state";

/** Memory, MCP approvals, front page, search, panes, and model-switch handlers.
 * Cross-hook: `viewFile` (files) is threaded in for search. */
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
    // Engine parity: whether connected MCP tools also ride along when a cloud
    // CLI answers (the advisor-tools switch) — the composer badge tells the
    // truth per engine with it.
    api
      .getSetting("advisor_tools_enabled")
      .then((v) => s.setAdvisorToolsOn(v === "1" || v === "on"))
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

  /** Wave 1b (idea 5): re-read the auto-save switch into the workspace ref.
   * Called when Settings closes — the BehaviorSection checkbox only writes the
   * DB setting, and the ref must follow without a room reopen. */
  function refreshMemAutoSave() {
    api
      .getSetting("memory_auto_save")
      .then((v) => {
        s.memAutoSaveRef.current = v === "1";
      })
      .catch(() => {});
  }

  /** Wave 1b (idea 10): open (get-or-create) the canonical scratch pad. */
  async function openScratchPad() {
    await tryToast(s, async () => {
      const meta = await api.openScratchPad();
      s.setFiles(await api.listFiles());
      await viewFile(meta.id);
    });
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

  /** Wave 1b (idea 5): the chip's third button — flip the room to auto-save
   * mode AND save the current suggestion. The click is the user's explicit
   * consent (the whole chip stays data-agent-blocked, ADD-25). */
  async function enableMemoryAutoSave() {
    const fact = s.memSuggestion?.fact;
    s.setMemSuggestion(null);
    s.memAutoSaveRef.current = true;
    await tryToast(s, async () => {
      await api.setSetting("memory_auto_save", "1");
      if (fact) {
        await api.addMemory(fact);
        s.setMemories(await api.listMemories());
      }
      s.pushToast(
        "success",
        "Suggested memories now save automatically — turn this off any time in Settings → Behavior.",
      );
    });
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
      () => api.addMemory(content, s.memoryDraftCat || null),
      async () => {
        s.setMemories(await api.listMemories());
        s.setMemoryDraft("");
        s.setMemoryDraftCat("");
      },
    );
  }

  async function saveMemoryEdit() {
    if (!s.editingMemory) return;
    const { id, content, category } = s.editingMemory;
    const trimmed = content.trim();
    s.setEditingMemory(null);
    if (!trimmed) return;
    await tryToast(
      s,
      () => api.updateMemory(id, trimmed, category),
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
      // A memory hit opens the Memory area, where the row can be edited.
      revealMemory();
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

  // Wave 2 (Idea 6): answer a diff-preview approval card.
  function resolveEditApproval(
    req: EditApproveRequest,
    decision: "once" | "turn" | "deny",
  ) {
    api.resolveEditApproval(req.id, decision).catch(() => {});
    s.setEditApprovals((q) => q.filter((r) => r.id !== req.id));
  }

  /** Open the Memory & Scratch Pad area (the center-pane manager). */
  function revealMemory() {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
    s.setArea("memory");
    s.setShowMemoryIntro(false);
    try {
      localStorage.setItem(`memoryIntroSeen:${info.name}`, "1");
    } catch {
      /* non-fatal */
    }
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

  return {
    refreshWebAccess, refreshAutolock, refreshMemAutoSave, dismissSyncWarn,
    connectedTools, approveMcp, keepMcpOff, loadFrontPage,
    saveSuggestedMemory, enableMemoryAutoSave, openScratchPad,
    copyReceipt, playSealSound, addMemory, saveMemoryEdit, activateResult,
    resolveMcpApproval, resolveEditApproval,
    revealMemory, changeModel, engineLabelOf,
    recordEngineModels,
    askConfirm, cancelConfirm, searchFlat,
  };
}
