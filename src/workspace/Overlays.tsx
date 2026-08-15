import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useFocusTrap } from "../settings/useFocusTrap";
import { api } from "../api";
import {
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  GlobeIcon,
  MicIcon,
  ScriptIcon,
  ShieldIcon,
} from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";
import DiffPreview from "../viewers/DiffPreview";
import { languageForFile } from "../viewers/languages";
import { LayoutApi } from "../shell/useLayout";
import { toggleTheme } from "../theme";
import { SCRIPT_POWERS, SCRIPT_WORKSPACE_NOTE } from "./scriptTrust";
import {
  applyFindFilters,
  DEFAULT_FILTERS,
  flattenShown,
  highlightTerms,
  kindsPresentOf,
  SearchFiltersBar,
  SearchIdlePanel,
  SearchQueryActions,
  SearchResultRows,
  useRecentAndSaved,
  type FindFilters,
} from "./SearchExpanded";

/** Human name for whoever owns the shared dictation mic right now. */
const CAPTURE_OWNER_LABEL: Record<string, string> = {
  note: "Voice note",
  journal: "Journal entry",
  composer: "Dictation",
  memory: "Spoken memory",
  file: "Dictating to file",
};

/** The capture dock — the one unmistakable "the microphone is doing
 * something" surface. Dictation-style capture (voice note, journal,
 * composer dictation) used to run with no visible state at all: the mic
 * was LIVE while the screen showed nothing. This pill names every phase —
 * Preparing → Recording (red dot + timer + Stop) → Transcribing — and is
 * fixed above the composer so it survives menu closes and view switches. */
function CaptureDock({ s }: { s: WSState }) {
  const [elapsed, setElapsed] = useState(0);
  const recording = s.dictState === "recording";
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);
  if (s.dictState === "idle") return null;
  const who = CAPTURE_OWNER_LABEL[s.dictOwner ?? ""] ?? "Recording";
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className={`capture-dock ${s.dictState}`} role="status">
      {s.dictState === "preparing" ? (
        <span className="capture-label">
          <MicIcon size={14} /> Preparing the microphone…
        </span>
      ) : s.dictState === "busy" ? (
        <span className="capture-label">
          <MicIcon size={14} /> {who} — transcribing on this Mac…
        </span>
      ) : (
        <>
          <span className="capture-label rec">
            <span className="rec-dot pulsing" /> {who} · {mm}:{ss}
          </span>
          {/* Live partial transcript for the non-composer mics (the composer
              paints its partials into the box itself). Voice notes have no
              partials — the span just stays empty for them. */}
          {s.dictPartial && s.dictOwner !== "composer" && (
            <span className="capture-partial" dir="auto">
              {s.dictPartial}
            </span>
          )}
          <button
            className="capture-stop"
            onClick={() => {
              // Voice notes still run on MediaRecorder; streaming dictation
              // stops through its session ref. Only one is ever active.
              s.recorderRef.current?.stop();
              s.dictStreamRef.current?.();
            }}
          >
            Stop &amp; save
          </button>
        </>
      )}
    </div>
  );
}

/** Roving keyboard focus for a pop-up menu built from plain buttons.
 *
 * The file "•••" menu could be OPENED from the keyboard and then not used: it
 * took no focus and answered no arrow keys, which put Rename, Move to… and
 * Remove — which exist nowhere else — out of reach for keyboard and
 * screen-reader users. Same behaviour the QuickActions menu already has. */
function useMenuKeys(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLDivElement | null>,
  /** Anything that changes the menu's ITEM LIST while it stays open. Arming
   * "Remove from room" swaps that one menuitem for a Delete/Keep pair: the
   * focused button unmounts, and since every item is `tabIndex={-1}` focus
   * falls to document.body — where no arrow key reaches the menu div that
   * carries the handler, so neither Delete nor Keep can be reached from the
   * keyboard. Re-running the focus effect on the change puts focus back on the
   * item now occupying that slot. */
  revision?: unknown,
) {
  const [focusIdx, setFocusIdx] = useState(0);
  useEffect(() => {
    if (open) setFocusIdx(0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const items = ref.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    items?.[Math.min(focusIdx, (items.length || 1) - 1)]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusIdx, revision]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const count =
      ref.current?.querySelectorAll('[role="menuitem"]:not(:disabled)').length ??
      0;
    if (count === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => (i - 1 + count) % count);
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocusIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocusIdx(count - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return { onKeyDown };
}

/** AUDIT 540: one keyboard-correct frame for the four consent cards.
 *
 * They render over a LIVE workspace — the Lock button is one of the things
 * sitting behind them — and moved focus nowhere at all. Tab walked straight out
 * of the card onto that chrome, and Escape reached the app-level handler, which
 * closed the FILE underneath instead of answering the question in front of you.
 * Settings has done this correctly the whole time (`useFocusTrap`); this puts
 * the four cards on the same frame.
 *
 * Escape DECLINES. It is the only answer that is safe to give by accident, and
 * a consent card whose Escape did nothing would leave a keyboard user with no
 * way out at all now that Tab no longer escapes it.
 *
 * Mounted per REQUEST (`key`), so the next card in the queue is a fresh
 * component and the trap's move-focus-in effect runs again for it.
 */
function ApproveCard({
  onDecline,
  label,
  wide,
  children,
}: {
  onDecline: () => void;
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const { modalRef, onModalKeyDown } = useFocusTrap(onDecline);
  return (
    <div className="approve-backdrop" data-agent-blocked>
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          // The app-level Escape handler (effects.ts) closes the open FILE.
          // This card is in front of that file and asking its own question, so
          // the answer must not carry past it — that mis-routing is half of
          // what made these cards unusable from the keyboard.
          if (e.key === "Escape") e.stopPropagation();
          onModalKeyDown(e);
        }}
        className={`approve-card${wide ? " approve-card-wide" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}

/** One executable palette command (searched alongside room content). */
type PaletteAction = {
  id: string;
  label: string;
  hint: string;
  disabled?: boolean;
  run: () => void;
};

/** Every palette command is a real handler — the same ones the chrome uses. */
function buildPaletteActions(
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
): PaletteAction[] {
  const leaveAreas = () => {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
  };
  const acts: PaletteAction[] = [
    { id: "new-chat", label: "New chat", hint: "Start a fresh conversation (⌘N)", run: () => a.newChat() },
    { id: "add-files", label: "Add files…", hint: "Import PDFs, notes, images, audio, sheets", run: () => a.importFiles() },
    { id: "new-page", label: "New page", hint: "A blank Markdown note, ready to edit", run: () => void a.createNewNote() },
    { id: "add-link", label: "Import a web link", hint: "A page or a YouTube transcript/video", run: () => { s.setLinkUrl(""); s.setShowAddLink(true); } },
    { id: "live-rec", label: "Start a live recording", hint: "Mic + Mac audio with a live transcript", disabled: s.recLive != null, run: () => void a.startLiveRecording() },
    { id: "voice-note", label: "Record a voice note", hint: "Starts the mic — audio saved in this room", disabled: a.micState("note").disabled, run: () => a.recordVoiceNote() },
    { id: "summarize", label: "Summarize the room", hint: "A cited overview, in the background", disabled: s.files.length === 0, run: () => void a.startDeepSummary() },
    // ----- every destination, pinned or not -----
    //
    // THIS LIST IS LOad-BEARING NOW, in a way it was not before. The sidebar
    // shows a short pinned set and keeps the rest behind a "More tools"
    // disclosure, so for anything unpinned this palette is the only route that
    // is always one keystroke away — and it is the ONLY route the embodiment
    // loop can take, since a collapsed disclosure is invisible to
    // `uiSnapshot()`. An area that exists and is missing here is an area the
    // agent cannot reach and a reader has to go hunting for.
    //
    // It had already fallen behind by three: Recordings, Create and Sketch
    // were all navigable from the old rail and absent from this list, so
    // anyone who navigated by ⌘K concluded the app did not have them.
    { id: "go-home", label: "Go to Room home", hint: "Recent work and capabilities", run: () => { leaveAreas(); s.setArea("home"); } },
    { id: "go-recordings", label: "Open Recordings", hint: "Mic and Mac audio, transcribed here", run: () => { leaveAreas(); s.setArea("recordings"); } },
    { id: "go-browser", label: "Open the private browser", hint: "Read the web with no history kept", run: () => a.revealBrowser() },
    { id: "go-sketch", label: "Open Sketch", hint: "Draw by hand, or ask the room to draw", run: () => { leaveAreas(); s.setArea("sketch"); } },
    { id: "go-create", label: "Open Create", hint: "Pictures and video from a connected model", run: () => { leaveAreas(); s.setArea("create"); } },
    { id: "go-map", label: "Open the Room Map", hint: "How files and notes connect", disabled: s.files.length < 2, run: () => { leaveAreas(); s.setShowMap(true); } },
    { id: "go-workflows", label: "Open Workflows", hint: "Pipelines, schedules, run history", run: () => a.openWorkflows() },
    { id: "go-scripts", label: "Open Scripts", hint: "Runnable .py/.js room files", run: () => a.openScripts() },
    { id: "go-skills", label: "Open Skills", hint: "Reusable instructions the AI can load", run: () => { leaveAreas(); s.setArea("skills"); } },
    { id: "go-connectors", label: "Open Connectors", hint: "MCP tools this room may use", run: () => { leaveAreas(); s.setArea("connectors"); } },
    { id: "go-memory", label: "Open Memory & scratch pad", hint: "Durable context, visible and editable", run: () => a.revealMemory() },
    // ----- the window's arrangement (same handlers the Layout menu uses) -----
    { id: "toggle-library", label: "Show or hide the sidebar", hint: "The left pane (⌘1)", run: () => layout?.togglePane("library") },
    { id: "toggle-assistant", label: "Show or hide the Assistant", hint: "Chat, Studio, and Activity (⌘2)", run: () => layout?.togglePane("ai") },
    { id: "focus-editor", label: "Focus the workspace", hint: "Hide both side panes", run: () => layout?.toggleFocus("center") },
    { id: "preset-focus", label: "Layout: Focus", hint: "The workspace alone", run: () => layout?.applyPreset("focus") },
    { id: "preset-research", label: "Layout: Research", hint: "Sidebar, workspace, and the assistant", run: () => layout?.applyPreset("research") },
    { id: "preset-review", label: "Layout: Review", hint: "Sidebar and workspace, no assistant", run: () => layout?.applyPreset("review") },
    { id: "reset-layout", label: "Reset the layout", hint: "Restore the balanced default", run: () => layout?.resetLayout() },
    { id: "theme", label: "Switch theme", hint: "Dark ⇄ light", run: () => toggleTheme() },
    { id: "checkpoint", label: "Save a checkpoint", hint: "A room-wide recovery point", run: () => { api.createRoomCheckpoint("").then((m) => s.pushToast("success", `Saved checkpoint “${m.name}”.`)).catch((e) => s.pushToast("error", String(e))); } },
    { id: "export-all", label: "Export all files…", hint: "Plain copies outside the room", disabled: s.files.length === 0, run: () => a.exportAllFiles() },
    { id: "settings", label: "Room settings", hint: "Models, privacy, voice, connections (⌘,)", run: () => s.setShowSettings(true) },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "Every shortcut in one sheet (⌘/)", run: () => s.setShowShortcuts(true) },
    { id: "feedback", label: "Send feedback…", hint: "Draft locally, then open GitHub", run: () => s.setShowFeedback(true) },
    { id: "lock", label: "Lock this room", hint: "Close and return to the gate (⌘L)", run: () => void a.handleLock() },
  ];
  // Without a layout there is no window to arrange, so every row that would
  // call into one is dropped rather than offered as a no-op. Matched on a
  // prefix set instead of by name so a preset added above cannot be forgotten
  // here and silently become a row that does nothing.
  const LAYOUT_ROWS = /^(toggle-library|toggle-assistant|focus-editor|preset-|reset-layout)/;
  if (!layout) return acts.filter((x) => !LAYOUT_ROWS.test(x.id));
  return acts;
}

/** Every keyboard shortcut this app answers, grouped the way the user meets
 * them. The app had over a dozen and no way to learn one except hovering the
 * right button; this sheet is the list. Keep it in step with the real handlers:
 * effects.ts (app), Workspace.tsx (tabs), useLayout.ts (panes), chatActions.ts
 * (composer), CodeEditor.tsx (save), PdfView.tsx (zoom). */
const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  {
    group: "Around the room",
    rows: [
      ["⌘K  /  ⌘F", "Search this room, or run a command"],
      ["⌘N", "New chat"],
      ["⌘,", "Room settings"],
      ["⌘J", "Pinned workflows"],
      ["⌘/", "This list"],
      ["⌘L", "Lock the room"],
      ["Esc", "Close the menu, sheet, or open file"],
    ],
  },
  {
    group: "Tabs",
    rows: [
      ["⌘W", "Close the current tab"],
      ["⇧⌘T", "Reopen the last file tab you closed"],
      ["⌘⇧]  /  ⌘⇧[", "Next / previous tab"],
      ["⌥⌘1 – ⌥⌘9", "Jump to a tab by position (⌥⌘9 = last)"],
    ],
  },
  {
    group: "Panes",
    rows: [
      ["⌘1", "Show or hide the sidebar"],
      ["⌘2", "Show or hide the Assistant"],
      // Named as an alias rather than quietly listed as an equal: ⌘3 has meant
      // the assistant since the shell had three panes, and it keeps meaning it
      // so nobody's hands have to relearn anything this release. ⌘2 is what it
      // will be called from here on.
      ["⌘3", "Show or hide the Assistant (the older shortcut, still works)"],
      ["Esc", "Leave a focused pane"],
    ],
  },
  {
    group: "Writing",
    rows: [
      ["Enter", "Send the message"],
      ["⇧Enter", "New line instead of sending"],
      ["@  /  #  /  /", "Mention a file, run a command, pick a prompt"],
      ["⌘S", "Save the file you are editing"],
      ["⌘Enter", "Run the prompt in a Studio or AI-action window"],
    ],
  },
  {
    group: "Reading a PDF",
    rows: [["⌘+ / ⌘- / ⌘0", "Zoom in, out, or fit the width"]],
  },
];

/** The keyboard-shortcuts sheet. Reuses the settings modal's frame so it is
 * dismissed exactly like every other sheet in the app. */
function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="settings-head">
          <span className="badge-label">Keyboard shortcuts</span>
          <button
            className="subtle btn-ic"
            title="Close"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="settings-body">
          {SHORTCUTS.map((sec) => (
            <section key={sec.group}>
              <div className="group-heading">{sec.group}</div>
              {sec.rows.map(([keys, what]) => (
                <div
                  key={keys + what}
                  className="brief-row info"
                  // The row style is shared with Home's brief, which spaces its
                  // rows from the list wrapper this sheet doesn't have.
                  style={{ marginBottom: 6 }}
                >
                  <span className="brief-text">{what}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Host of a URL, for the consent card's "on <site>" phrasing. Falls back to
 *  the raw string so a malformed URL still reads sensibly rather than blank. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "this page";
  }
}

/** The fixed-position overlays that sit above everything: the MCP tool-call
 * approval card, the file context menu, the "Move to…" menu, the Finder-drop
 * highlight, and the ⌘K search/command palette. */
export default function Overlays({
  s,
  a,
  layout,
}: {
  s: WSState;
  a: WSActions;
  layout?: LayoutApi;
}) {
  const pendingApproval = s.mcpApprovals[0];
  const pendingBrowse = s.browseConsents[0];
  const pendingEdit = s.editApprovals[0];
  const pendingScript = s.scriptApprovals[0];

  // ---- ⌘K: the expanded results (P1-2) ----
  // The room used to have a second, full-page "Find" area for exactly this —
  // filters, previews, saved/recent searches. That page is retired; its
  // internals now live in SearchExpanded.tsx and render here, once a real
  // query has real results, instead of on a separate pane.
  const searchResults = s.searchResults;
  const trimmedQuery = s.searchQuery.trim();
  const [filters, setFilters] = useState<FindFilters>(DEFAULT_FILTERS);
  // A fresh open starts from a clean filter set: carrying "PDFs only, past
  // week" over from the last time ⌘K was open would silently narrow a search
  // the reader never asked to narrow.
  useEffect(() => {
    if (s.showSearch) setFilters(DEFAULT_FILTERS);
  }, [s.showSearch]);
  const fileById = useMemo(() => new Map(s.files.map((f) => [f.id, f])), [s.files]);
  // The ONE narrowing pass. The keyboard selection below and the rows drawn
  // near the bottom of this component both read `shown` — never the raw
  // `searchResults` — so a filtered view and what Enter actually activates
  // can never disagree about which row is which.
  const shown = useMemo(
    () => applyFindFilters(searchResults, filters, fileById),
    [searchResults, filters, fileById],
  );
  const flatShown = useMemo(() => flattenShown(shown), [shown]);
  const kindsPresent = useMemo(() => kindsPresentOf(searchResults, fileById), [searchResults, fileById]);
  const terms = useMemo(() => highlightTerms(trimmedQuery), [trimmedQuery]);
  // Changing a filter is a deliberate act, and the list it points into just
  // changed shape — the selection resets to the top rather than keep an index
  // that, once Commands are appended after it, could now land on the WRONG
  // command entirely.
  useEffect(() => {
    s.setSearchSel(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const { recent, saved, noteSearch, toggleSaved, removeSaved, clearRecent } = useRecentAndSaved();
  // Recorded once per COMPLETED search, not once per keystroke: effects.ts
  // cancels every keystroke's request but the last, so `searchResults`
  // changing identity is exactly "a search finished".
  useEffect(() => {
    if (trimmedQuery && searchResults) noteSearch(trimmedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResults]);
  const isSavedSearch = saved.some((sv) => sv.q === trimmedQuery);

  // Commands that match the query (all of them at rest — the palette's
  // resting state lists what the room can do instead of a blank panel).
  const q = s.searchQuery.trim().toLowerCase();
  const actions = buildPaletteActions(s, a, layout).filter(
    (x) => !q || x.label.toLowerCase().includes(q) || x.hint.toLowerCase().includes(q),
  );
  const actOffset = flatShown.length;
  const totalItems = flatShown.length + actions.length;
  // Unfiltered totals, for the ONE question filters must never answer wrong:
  // "is there really nothing here" vs "these filters are hiding something
  // that IS here". Swapping the filtered counts into that message would tell
  // someone their room has nothing matching a word that, in fact, thirty
  // messages contain — just not the ones the current filters let through.
  const totalRaw = searchResults
    ? searchResults.files.length + searchResults.messages.length + searchResults.memories.length
    : 0;
  const totalItemsRaw = totalRaw + actions.length;
  const totalShown = shown.files.length + shown.messages.length + shown.memories.length;
  const narrowedToZero = totalRaw > 0 && totalShown === 0;
  const expanded = trimmedQuery !== "" && searchResults != null && !s.searchError;
  const runSel = (idx: number) => {
    if (idx < flatShown.length) {
      a.activateResult(flatShown[idx], layout);
      return;
    }
    const act = actions[idx - actOffset];
    if (act && !act.disabled) {
      s.setShowSearch(false);
      act.run();
    }
  };
  const ctxKeys = useMenuKeys(
    s.ctxMenu !== null,
    () => s.setCtxMenu(null),
    s.ctxMenuElRef,
    // Arming/disarming the delete confirm is the one thing that rewrites this
    // menu's items while it is open.
    s.confirmDelete,
  );
  const moveKeys = useMenuKeys(
    s.moveMenuFor !== null,
    () => s.setMoveMenuFor(null),
    s.moveMenuElRef,
  );
  // The highlight has to drag the list along with it: arrow-keying past the
  // fold otherwise leaves you pressing Enter on a row you cannot see. Same
  // treatment the composer's own suggestion list already has.
  const keepVisible = (idx: number) => (el: HTMLButtonElement | null) => {
    if (idx === s.searchSel) el?.scrollIntoView({ block: "nearest" });
  };
  const onPaletteKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      s.setSearchSel((sel) => Math.min(sel + 1, Math.max(totalItems - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      s.setSearchSel((sel) => Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSel(s.searchSel);
    }
  };
  return (
    <>
      <CaptureDock s={s} />
      {s.showShortcuts && (
        <ShortcutsSheet onClose={() => s.setShowShortcuts(false)} />
      )}
      {pendingScript && (
        // Wave 5 (Idea 13): the script-run consent card. Same data-agent-blocked
        // surface as the MCP/edit cards — the UI-driving agent must never approve
        // its own script. The two honest sentences state the real trust class.
        <ApproveCard
          key={pendingScript.id}
          label="Run a script from this room?"
          onDecline={() => a.resolveScriptApproval(pendingScript, "deny")}
        >
          <>
            {/* The marker category label: what CLASS of decision this is,
                before the sentence that asks it. Yellow is "needs review"
                product-wide, and these three cards are all the same kind of
                ask — a program wants to run. The deletion card below uses the
                red "urgent" marker instead, because it is the one that
                destroys something. */}
            <div className="approve-kind">
              <span className="nb-cat nb-sem-pending">Permission</span>
            </div>
            <div className="approve-title">
              <ScriptIcon size={16} /> Run a script from this room?
            </div>
            <p className="approve-body">
              <strong>{pendingScript.name}</strong> is a real program:{" "}
              <strong>{SCRIPT_POWERS}</strong> {SCRIPT_WORKSPACE_NOTE}
            </p>
            <pre className="approve-args">{pendingScript.interpreterLine}</pre>
            {pendingScript.deps.length > 0 && (
              <div className="script-approve-line">
                <span className="script-approve-key">Installs</span>
                <pre className="approve-args">{pendingScript.deps.join(", ")}</pre>
              </div>
            )}
            {pendingScript.inputs.length > 0 && (
              <div className="script-approve-line">
                <span className="script-approve-key">Reads</span>
                <pre className="approve-args">{pendingScript.inputs.join(", ")}</pre>
              </div>
            )}
            {pendingScript.outputs.length > 0 && (
              <div className="script-approve-line">
                <span className="script-approve-key">Writes back</span>
                <pre className="approve-args">{pendingScript.outputs.join(", ")}</pre>
              </div>
            )}
            <p className="approve-body caption">
              <strong>Allow once</strong> runs it this one time and keeps it marked “Needs review”.
              <br />
              <strong>Always allow this exact script</strong> approves this version — it stops asking
              and can be scheduled. Any edit to the script asks again.
            </p>
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveScriptApproval(pendingScript, "once")}
              >
                Allow once
              </button>
              <button onClick={() => a.resolveScriptApproval(pendingScript, "always")}>
                Always allow this exact script
              </button>
              <button
                className="danger"
                onClick={() => a.resolveScriptApproval(pendingScript, "deny")}
              >
                Don't run
              </button>
            </div>
          </>
        </ApproveCard>
      )}
      {pendingApproval?.confirm && (
        // Audit #505: an agent-initiated DELETION. Its own card, because the
        // tool-call one below asks the wrong question (nothing is being run,
        // and nothing may be "always allowed" — there is no trash for a
        // connector, so this card IS the undo). Same data-agent-blocked
        // surface: the agent must never click its own confirmation.
        <ApproveCard
          key={pendingApproval.id}
          label={`Delete the ${pendingApproval.tool} “${pendingApproval.server}”?`}
          onDecline={() => a.resolveMcpApproval(pendingApproval, "deny")}
        >
          <>
            <div className="approve-kind">
              <span className="nb-cat nb-sem-urgent">Deletion</span>
            </div>
            <div className="approve-title">
              <ShieldIcon size={16} /> Delete the {pendingApproval.tool}{" "}
              &ldquo;{pendingApproval.server}&rdquo;?
            </div>
            <p className="approve-body">
              The AI asked to delete this {pendingApproval.tool}.{" "}
              {pendingApproval.confirm}
            </p>
            <div className="approve-actions">
              <button
                className="danger"
                onClick={() => a.resolveMcpApproval(pendingApproval, "once")}
              >
                Delete it
              </button>
              <button
                className="primary"
                onClick={() => a.resolveMcpApproval(pendingApproval, "deny")}
              >
                Keep it
              </button>
            </div>
          </>
        </ApproveCard>
      )}
      {pendingApproval && !pendingApproval.confirm && (
        // ADD-25: consent surface — the agent must never be able to click its
        // own tool-call approval ("Allow"), so the driver can't see it.
        <ApproveCard
          key={pendingApproval.id}
          label="Allow a connected tool to run?"
          onDecline={() => a.resolveMcpApproval(pendingApproval, "deny")}
        >
          <>
            <div className="approve-kind">
              <span className="nb-cat nb-sem-pending">Permission</span>
            </div>
            <div className="approve-title">
              <GlobeIcon size={16} /> Allow a connected tool to run?
            </div>
            <p className="approve-body">
              The AI wants to use{" "}
              <strong>{pendingApproval.tool}</strong> from the{" "}
              <strong>{pendingApproval.server}</strong> connector. This is a
              separate program that can reach the internet — what the AI sends
              it leaves this room.
            </p>
            {pendingApproval.args && pendingApproval.args !== "{}" && (
              <pre className="approve-args">{pendingApproval.args}</pre>
            )}
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveMcpApproval(pendingApproval, "once")}
              >
                Allow once
              </button>
              <button
                onClick={() => a.resolveMcpApproval(pendingApproval, "always")}
              >
                Always allow this connector
              </button>
              <button
                className="danger"
                onClick={() => a.resolveMcpApproval(pendingApproval, "deny")}
              >
                Don't allow
              </button>
            </div>
          </>
        </ApproveCard>
      )}
      {pendingBrowse && (
        // BROWSE-1: the OUTBOUND door — room content about to be typed into a
        // web page. `data-agent-blocked` for the same reason as every other
        // consent surface: the agent must never be able to click its own
        // approval. Shown with the REAL values, because the point is that the
        // user is deciding about their own data.
        //
        // The browser's native webview is parked to 1x1 while this is open
        // (BrowserView) — it floats above the whole window, so a modal cannot
        // otherwise be seen.
        <ApproveCard
          key={pendingBrowse.id}
          label="Type this into the page?"
          onDecline={() => a.resolveBrowseConsent(pendingBrowse, false)}
        >
          <>
            {/* Red, not yellow: nothing is being deleted, but this is the one
                card where saying yes puts room content OUTSIDE the room, and
                that is irreversible in exactly the way a deletion is. */}
            <div className="approve-kind">
              <span className="nb-cat nb-sem-urgent">Leaves this room</span>
            </div>
            <div className="approve-title">
              <ShieldIcon size={16} /> Type this into the page?
            </div>
            <p className="approve-body">
              The assistant wants to type this into{" "}
              <strong>{pendingBrowse.field}</strong> on{" "}
              <strong>{hostOf(pendingBrowse.url)}</strong>.{" "}
              {pendingBrowse.entities.length > 0
                ? "It matches information you asked to keep private."
                : /* No entity map for this room, so the door matched nothing —
                     and "nothing matched" is not "nothing private". Saying
                     which of the two happened is the whole point of the card. */
                  "This room has no list of protected details, so Arcelle cannot check it against one."}{" "}
              Once it is typed, that site has it.
            </p>
            <pre className="approve-args">{pendingBrowse.text}</pre>
            {pendingBrowse.entities.length > 0 && (
              <p className="approve-body">
                Recognised: {pendingBrowse.entities.join(", ")}
              </p>
            )}
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveBrowseConsent(pendingBrowse, true)}
              >
                Type it
              </button>
              <button
                className="danger"
                onClick={() => a.resolveBrowseConsent(pendingBrowse, false)}
              >
                Don't
              </button>
            </div>
          </>
        </ApproveCard>
      )}
      {pendingEdit && (
        // Wave 2 (Idea 6): the diff-preview approval card. Same data-agent-blocked
        // consent surface as the MCP card — the UI-driving agent must never be
        // able to approve its own edit.
        <ApproveCard
          key={pendingEdit.id}
          wide
          label="Apply this change?"
          onDecline={() => a.resolveEditApproval(pendingEdit, "deny")}
        >
          <>
            <div className="approve-kind">
              <span className="nb-cat nb-sem-pending">File change</span>
            </div>
            <div className="approve-title">
              Apply {pendingEdit.files.length > 1 ? "these changes" : "this change"} to{" "}
              {pendingEdit.files.length === 1 ? (
                <em>{pendingEdit.files[0].name}</em>
              ) : (
                <strong>{pendingEdit.files.length} files</strong>
              )}
              ?
            </div>
            <div className="approve-diffs">
              {pendingEdit.files.slice(0, 5).map((f, i) => (
                <div className="approve-diff-file" key={`${f.name}-${i}`}>
                  {pendingEdit.files.length > 1 && (
                    <div className="approve-diff-name">{f.name}</div>
                  )}
                  <DiffPreview
                    before={f.before}
                    after={f.after}
                    clipped={f.clipped}
                    language={languageForFile(f.name)}
                  />
                </div>
              ))}
              {pendingEdit.files.length > 5 && (
                <div className="approve-diff-more">
                  …and {pendingEdit.files.length - 5} more file(s) in this change.
                </div>
              )}
            </div>
            <div className="approve-actions">
              <button
                className="primary"
                onClick={() => a.resolveEditApproval(pendingEdit, "once")}
              >
                Apply
              </button>
              {pendingEdit.allowTurn && (
                <button onClick={() => a.resolveEditApproval(pendingEdit, "turn")}>
                  Apply for the rest of this answer
                </button>
              )}
              <button
                className="danger"
                onClick={() => a.resolveEditApproval(pendingEdit, "deny")}
              >
                Don't apply
              </button>
            </div>
          </>
        </ApproveCard>
      )}
      {s.ctxMenu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => s.setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); s.setCtxMenu(null); }} />
          <div
            ref={s.ctxMenuElRef}
            className="ctx-menu"
            role="menu"
            aria-label={`Actions for ${s.ctxMenu.file.name}`}
            onKeyDown={ctxKeys.onKeyDown}
            style={{ top: s.ctxMenu.y, left: s.ctxMenu.x }}
          >
            {/* MANY vs ONE. When the right-clicked row is part of the
                selection, `files` is the whole selection and every label says
                so — a menu that reads "Move to…" while it is about to move
                seven files is the bug this count prevents. The single-subject
                items (Open, Rename) stay on `file`, which is the row actually
                clicked, so they never have to guess. */}
            {s.ctxMenu.files.length > 1 && (
              <div className="ctx-heading">
                <span className="nb-cat nb-sem-linked">
                  {s.ctxMenu.files.length} files selected
                </span>
              </div>
            )}
            {s.ctxMenu.files.length === 1 && (
              <>
                <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { a.viewFile(s.ctxMenu!.file.id); s.setCtxMenu(null); }}>Open</button>
                <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { a.toggleAttach(s.ctxMenu!.file); s.setCtxMenu(null); }}>{s.attachments.some((x) => x.id === s.ctxMenu!.file.id) ? "Detach from chat" : "Attach to chat"}</button>
                <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { s.setRenamingFile({ id: s.ctxMenu!.file.id, name: s.ctxMenu!.file.name, where: "library" }); s.setCtxMenu(null); }}>Rename…</button>
              </>
            )}
            {s.ctxMenu.files.length > 1 && (
              <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { a.attachFiles(s.ctxMenu!.files); s.setCtxMenu(null); }}>Attach {s.ctxMenu.files.length} to chat</button>
            )}
            <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { s.setMoveMenuFor({ ids: s.ctxMenu!.files.map((f) => f.id), x: s.ctxMenu!.x, y: s.ctxMenu!.y }); s.setCtxMenu(null); }}>
              {s.ctxMenu.files.length > 1 ? `Move ${s.ctxMenu.files.length} files to…` : "Move to…"}
            </button>
            <button role="menuitem" tabIndex={-1} className="ctx-item" onClick={() => { const fs = s.ctxMenu!.files; s.setCtxMenu(null); if (fs.length > 1) void a.exportFiles(fs); else a.exportOne(fs[0].id, fs[0].name); }}>
              {s.ctxMenu.files.length > 1 ? `Export ${s.ctxMenu.files.length} copies…` : "Export a copy…"}
            </button>
            {(s.aiActionDefs ?? []).some((x) => x.scope === "file") && (
              <>
                {/* .nb-rule is the tapered pencil stroke from paper.css — it
                    thins toward both ends instead of butting into the menu's
                    edges, which is the difference between a drawn separator
                    and a hairline border. */}
                <div className="ctx-sep nb-rule" />
                <div className="ctx-heading">
                  <span className="nb-cat nb-sem-saved">
                    {/* An action over seven files must not be introduced as
                        "this file" — the heading is what tells the reader how
                        much material the run is about to read. */}
                    AI actions ·{" "}
                    {s.ctxMenu.files.length > 1
                      ? `these ${s.ctxMenu.files.length} files`
                      : "this file"}
                  </span>
                </div>
                {(s.aiActionDefs ?? [])
                  .filter((x) => x.scope === "file")
                  .map((x) => (
                    <button
                      key={x.id}
                      role="menuitem"
                      tabIndex={-1}
                      className="ctx-item"
                      title={x.description}
                      onClick={() => {
                        // `refs` already takes a LIST, so a multi-file AI action
                        // needed no new plumbing — only the ids the user picked.
                        const ids = s.ctxMenu!.files.map((f) => f.id);
                        s.setCtxMenu(null);
                        a.openAiAction(x, null, ids);
                      }}
                    >
                      {x.title}
                    </button>
                  ))}
              </>
            )}
            <div className="ctx-sep nb-rule" />
            {s.confirmDelete === `ctx-remove-${s.ctxMenu.file.id}` ? (
              // ADD-25: the agent driver must not be able to click ✓ on a
              // removal it didn't earn.
              <div className="ctx-confirm" data-agent-blocked>
                {/* Say what actually happens. This IS a trash can now: the
                    file leaves the library, the counts and the AI's search,
                    and waits in Library → Trash with its versions and its
                    transcript intact until someone destroys it there. The
                    wording this replaced ("Delete permanently, with its
                    history?") described the pre-trash behaviour and would now
                    be a false warning. */}
                <span className="ctx-confirm-q">
                  {s.ctxMenu.files.length > 1
                    ? `Move ${s.ctxMenu.files.length} files to the trash?`
                    : "Move to the trash?"}
                </span>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="ctx-item danger btn-ic"
                  onClick={() => {
                    const ids = s.ctxMenu!.files.map((f) => f.id);
                    a.cancelConfirm();
                    s.setCtxMenu(null);
                    // One command for many, the single-file one for one — so a
                    // lone removal keeps its existing toast wording exactly.
                    if (ids.length > 1) void a.removeFiles(ids);
                    else void a.removeFile(ids[0]);
                  }}
                >
                  <CheckIcon size={14} /> Move to trash
                </button>
                <button
                  role="menuitem"
                  tabIndex={-1}
                  className="ctx-item btn-ic"
                  onClick={a.cancelConfirm}
                >
                  <CloseIcon size={14} /> Keep
                </button>
              </div>
            ) : (
              <button
                role="menuitem"
                tabIndex={-1}
                className="ctx-item danger"
                onClick={() => a.askConfirm(`ctx-remove-${s.ctxMenu!.file.id}`)}
              >
                {s.ctxMenu.files.length > 1
                  ? `Remove ${s.ctxMenu.files.length} files from room`
                  : "Remove from room"}
              </button>
            )}
          </div>
        </>
      )}
      {s.moveMenuFor && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => s.setMoveMenuFor(null)}
            onContextMenu={(e) => { e.preventDefault(); s.setMoveMenuFor(null); }}
          />
          <div
            ref={s.moveMenuElRef}
            className="ctx-menu"
            role="menu"
            aria-label="Move to a folder"
            onKeyDown={moveKeys.onKeyDown}
            style={{ top: s.moveMenuFor.y, left: s.moveMenuFor.x }}
          >
            <div className="ctx-heading">
              <span className="nb-cat nb-sem-linked">
                {s.moveMenuFor.ids.length > 1
                  ? `Move ${s.moveMenuFor.ids.length} files to…`
                  : "Move to…"}
              </span>
            </div>
            {(() => {
              const ids = s.moveMenuFor!.ids;
              const moving = s.files.filter((f) => ids.includes(f.id));
              // A destination is only "where they already are" when EVERY file
              // is there. Disabling on the first file's folder would grey out a
              // real move for the other six.
              const allIn = (folderId: string | null) =>
                moving.length > 0 &&
                moving.every((f) => (f.folderId ?? null) === folderId);
              return (
                <>
                  <button
                    role="menuitem"
                    tabIndex={-1}
                    className="ctx-item"
                    disabled={allIn(null)}
                    onClick={() => { void a.moveFiles(ids, null); }}
                  >
                    No folder
                  </button>
                  {s.folders.map((fo) => (
                    <button
                      key={fo.id}
                      role="menuitem"
                      tabIndex={-1}
                      className="ctx-item"
                      disabled={allIn(fo.id)}
                      onClick={() => { void a.moveFiles(ids, fo.id); }}
                    >
                      {fo.name}
                    </button>
                  ))}
                  {s.folders.length === 0 && (
                    // An empty state names what would fill it and where the
                    // action lives. "No folders yet" on its own left a dead
                    // menu with no route out of it — the only place a folder
                    // can be made is the Library's "Add page or source" menu,
                    // and this is the moment somebody wants to know that.
                    <div className="ctx-empty">
                      No folders yet — make one from &ldquo;Add page or
                      source&rdquo; in the Library.
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}
      {s.dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <DownloadIcon size={28} />
            <span>Drop to add to this room</span>
          </div>
        </div>
      )}
      {s.showSearch && (
        <div
          className="search-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) s.setShowSearch(false);
          }}
        >
          <div className={`search-panel${expanded ? " is-expanded" : ""}`}>
            <input
              className="search-input"
              autoFocus
              dir="auto"
              placeholder="Search this room, or run a command…"
              aria-label="Search this room or run a command"
              value={s.searchQuery}
              onChange={(e) => {
                s.setSearchQuery(e.target.value);
                s.setSearchSel(0);
              }}
              onKeyDown={onPaletteKey}
            />
            <div className="search-results">
              {/* A failed search clears its results, so this is the only thing
                  on screen — the previous query's hits never linger under a
                  query that never ran. */}
              {s.searchError && (
                <div className="find-error nb-frame nb-sem-urgent nb-edge" role="alert">
                  <strong className="find-error-head">This room could not be searched</strong>
                  <span className="find-error-body">{s.searchError}</span>
                </div>
              )}
              {/* Genuinely nothing — not a filtered view of something that IS
                  there. Reads the UNFILTERED total plus commands, same gate
                  the plain palette always used, so turning a filter on can
                  never make this message start lying. */}
              {trimmedQuery !== "" && searchResults && totalItemsRaw === 0 && (
                <div className="search-empty">
                  Nothing matches “{trimmedQuery}” — not in files, chats,
                  memories, or commands.
                </div>
              )}
              {expanded && (
                <>
                  <SearchQueryActions
                    query={trimmedQuery}
                    isSaved={isSavedSearch}
                    onToggleSaved={() => toggleSaved(trimmedQuery, filters)}
                    onAsk={(question) => {
                      s.setShowSearch(false);
                      s.setQuestion(question);
                      a.focusComposer(layout);
                    }}
                  />
                  <SearchFiltersBar
                    filters={filters}
                    onChange={setFilters}
                    results={searchResults}
                    kindsPresent={kindsPresent}
                    messagesOrMemoriesShown={shown.messages.length > 0 || shown.memories.length > 0}
                    showSort={shown.files.length > 0}
                  />
                  {/* A live region, mounted for every completed search: a
                      screen reader hears the count change as the reader
                      types or narrows a filter — including down to zero,
                      which a div that simply stopped rendering never would
                      announce. */}
                  <p className="find-count" role="status">
                    {totalShown === 0
                      ? `No results for “${trimmedQuery}”`
                      : totalShown !== totalRaw
                        ? `${totalShown} of ${totalRaw} results for “${trimmedQuery}”`
                        : `${totalShown} result${totalShown === 1 ? "" : "s"} for “${trimmedQuery}”`}
                  </p>
                  {totalShown > 0 && (
                    <p className="find-breakdown">
                      {shown.files.length} file{shown.files.length === 1 ? "" : "s"} ·{" "}
                      {shown.messages.length} message{shown.messages.length === 1 ? "" : "s"} ·{" "}
                      {shown.memories.length} memor{shown.memories.length === 1 ? "y" : "ies"}
                    </p>
                  )}
                  {narrowedToZero ? (
                    <div className="find-empty">
                      <p className="find-empty-line">
                        Nothing matches “{trimmedQuery}” with these filters — {totalRaw}{" "}
                        result{totalRaw === 1 ? " is" : "s are"} hidden by them.
                      </p>
                      <div className="find-empty-actions">
                        <button type="button" className="nb-btn" onClick={() => setFilters(DEFAULT_FILTERS)}>
                          Clear filters
                        </button>
                      </div>
                    </div>
                  ) : (
                    <SearchResultRows
                      shown={shown}
                      files={s.files}
                      fileById={fileById}
                      terms={terms}
                      selectedIndex={s.searchSel}
                      registerRowRef={keepVisible}
                      onSelectIndex={(idx) => s.setSearchSel(idx)}
                      onOpenResult={(r) => a.activateResult(r, layout)}
                      onOpenFile={(id) => void a.viewFile(id)}
                    />
                  )}
                </>
              )}
              {trimmedQuery === "" && (
                <SearchIdlePanel
                  recent={recent}
                  saved={saved}
                  onRunRecent={(query) => s.setSearchQuery(query)}
                  onRunSaved={(sv) => {
                    setFilters(sv.filters);
                    s.setSearchQuery(sv.q);
                  }}
                  onRemoveSaved={removeSaved}
                  onClearRecent={clearRecent}
                />
              )}
              {actions.length > 0 && (
                <div className="search-group">
                  <div className="search-group-head">
                    Commands <span className="search-count">{actions.length}</span>
                  </div>
                  {actions.map((act, i) => {
                    const idx = actOffset + i;
                    return (
                      <button
                        key={act.id}
                        ref={keepVisible(idx)}
                        className={`search-result action ${s.searchSel === idx ? "sel" : ""}`}
                        disabled={act.disabled}
                        onMouseEnter={() => s.setSearchSel(idx)}
                        onClick={() => runSel(idx)}
                      >
                        <span className="search-result-title">{act.label}</span>
                        <span className="search-result-snippet">{act.hint}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="search-hint">
              ↑↓ to move · Enter to run · Esc to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
