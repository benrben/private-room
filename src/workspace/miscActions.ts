import {
  AnnotationPayload,
  api,
  EditApproveRequest,
  engineModelLabel,
  ExternalModelInfo,
  frontPage,
  frontPageSuggestions,
  BrowseConsentRequest,
  McpApproveRequest,
  McpServerStatus,
  RoomInfo,
} from "../api";
import { tryToast } from "./guard";
import { MEMORY_INTRO_SEEN } from "./constants";
import { FlatResult } from "./types";
import { WSState } from "./state";
import type { LayoutApi } from "../shell/useLayout";

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
      // Anything but "off"/unset is on. The retired provider names still read as
      // on, so a room saved before the switch keeps its internet access — same
      // rule as `web_access_enabled` in commands.rs.
      .then((v) => s.setWebOn(!!v && v !== "off"))
      .catch(() => {});
    // Engine parity: whether connected MCP tools also ride along when a cloud
    // CLI answers (the advisor-tools switch) — the composer badge tells the
    // truth per engine with it.
    api
      .getSetting("advisor_tools_enabled")
      .then((v) => s.setAdvisorToolsOn(v === "1" || v === "on"))
      .catch(() => {});
  }

  // PRIV-1: whether the cloud-privacy door is effectively on for this room.
  function refreshPrivacy() {
    api
      .privacyStatus()
      .then((st) => s.setPrivacyOn(st.effectiveOn))
      .catch(() => s.setPrivacyOn(null));
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

  /** Scroll a chat message into view and MARK it, once the conversation it
   * belongs to has actually rendered. A single fixed delay was a guess: a long
   * conversation was still painting when it expired, so the jump landed at the
   * bottom of the chat and the matching message was never pointed out. */
  function revealMessage(messageId: string, tries = 40) {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) {
      if (tries > 0)
        window.setTimeout(() => revealMessage(messageId, tries - 1), 50);
      return;
    }
    el.scrollIntoView({ block: "center" });
    // Set directly rather than through a class: this mark is temporary by
    // design and must never look like a stuck selection.
    el.style.outline = "2px solid var(--accent)";
    el.style.outlineOffset = "3px";
    el.style.borderRadius = "8px";
    window.setTimeout(() => {
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.style.borderRadius = "";
    }, 2600);
  }

  /** Open whatever a ⌘K result points at.
   *
   * `layout` is optional only because the flat-result list is reachable from
   * surfaces that have no window to arrange; every caller inside the workspace
   * passes it, and a MESSAGE hit genuinely needs it — see below. */
  function activateResult(r: FlatResult, layout?: LayoutApi) {
    if (r.kind === "file") {
      viewFile(r.id, { find: r.snippet });
    } else if (r.kind === "message") {
      s.setActiveChatId(r.chatId);
      // The message lives in the chat tab — a hit picked while Studio or
      // Activity is showing must bring the conversation forward first...
      s.setAiTab("chat");
      // ...and the PANE has to come forward too. Switching the tab alone was
      // the one path in the app that changed which tab was selected without
      // making sure that tab could be seen: with the assistant collapsed,
      // picking a message out of ⌘K selected a chat behind a closed column and
      // looked, from the outside, exactly like the click doing nothing. Every
      // other `setAiTab` caller already pairs the two (see `focusComposer`
      // just below, and Room Home's chat and activity rows); this one did not.
      layout?.showPane("ai");
      // The transcript paints only its newest page, so a hit on an older
      // message has no element to scroll to — ask the pane to widen its page
      // first, or `revealMessage` polls for two seconds and gives up silently.
      s.setRevealMsgId(r.messageId);
      revealMessage(r.messageId);
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

  /** BROWSE-1: answer the outbound-typing door.
   *
   * The tool call is parked on the same oneshot the DOM driver would have
   * answered, so BOTH outcomes must reply — a dropped card would hang the
   * agent's turn until its timeout rather than failing honestly.
   */
  function resolveBrowseConsent(req: BrowseConsentRequest, approved: boolean) {
    // A card outlives the tool call waiting on it: the call gives up on its own
    // budget and is told nobody approved, while the card sits there. Pressing
    // Allow after that used to succeed silently — card gone, nothing typed, the
    // user believing they had approved it. The host now says so, and so do we.
    api.resolveAgentUi(req.id, { approved }).catch((e) => {
      if (approved) s.pushToast("error", String(e));
    });
    s.setBrowseConsents((q) => q.filter((r) => r.id !== req.id));
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
    // A room setting, not a browser key keyed by file name — see constants.ts.
    api.setSetting(MEMORY_INTRO_SEEN, "1").catch(() => {
      /* non-fatal: the intro is cosmetic */
    });
  }

  /** Put the question box in front of the user, then focus it.
   *
   * "Ask the room" and the suggested questions used to focus a textarea that
   * simply isn't mounted on the Studio/Activity tab or when the AI pane is
   * collapsed — the click did nothing, and a chosen suggestion was stored out
   * of sight. Show the pane and the chat tab FIRST; the composer may only be
   * mounting as a result, so the focus retries briefly. */
  function focusComposer(layout?: LayoutApi) {
    s.setAiTab("chat");
    layout?.showPane("ai");
    const tryFocus = (tries: number) => {
      const el = s.composerRef.current;
      if (el) {
        el.focus();
        return;
      }
      if (tries > 0) window.setTimeout(() => tryFocus(tries - 1), 40);
    };
    tryFocus(12);
  }

  /** BROWSE-1: bring the private browser forward.
   *
   * Needed because the agent can open a page while the user is anywhere in the
   * app. The page is a NATIVE webview positioned over this window — it does not
   * belong to whatever pane happens to be showing — so if the area did not
   * follow, a page would simply appear on top of the Files list with no way to
   * reach its chrome.
   */
  function revealBrowser() {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
    s.setArea("browser");
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
  /** Arm the "Delete? ✓ ✕" question. It WAITS for an answer: it used to
   * disarm itself after three seconds, so anyone who paused to read it clicked
   * ✓ on a button that had already turned back into the bin — which just
   * re-asked, and read as a broken control. Only ✕, another armed confirm, or
   * an explicit cancel takes it back down. */
  function askConfirm(key: string) {
    s.setConfirmDelete(key);
  }

  function cancelConfirm() {
    s.setConfirmDelete(null);
  }

  return {
    refreshWebAccess, refreshAutolock, refreshPrivacy, refreshMemAutoSave, dismissSyncWarn,
    connectedTools, approveMcp, keepMcpOff, loadFrontPage,
    saveSuggestedMemory, enableMemoryAutoSave, openScratchPad,
    copyReceipt, playSealSound, addMemory, saveMemoryEdit, activateResult,
    resolveMcpApproval, resolveEditApproval, resolveBrowseConsent,
    revealMemory, revealBrowser, focusComposer, changeModel, engineLabelOf,
    recordEngineModels,
    askConfirm, cancelConfirm,
  };
}
