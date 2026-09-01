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
import { CloseIcon, MicIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { LayoutApi } from "../shell/useLayout";
import { toggleTheme } from "../theme";
import { newItemLabel, newItemOf } from "./destinations";
import type { WorkArea } from "./types";
import SealedExportDialog from "./SealedExportDialog";
import { ApprovalOverlays, ContextMenuOverlay, DragOverlay, MoveMenuOverlay } from "./OverlayMenus";
import { SearchOverlay } from "./OverlaySearch";

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
function useCaptureElapsed(recording: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);
  return elapsed;
}

function captureOwner(s: WSState) {
  return CAPTURE_OWNER_LABEL[s.dictOwner ?? ""] ?? "Recording";
}

function CapturePreparing() {
  return (
    <span className="capture-label">
      <MicIcon size={14} /> Preparing the microphone…
    </span>
  );
}

function CaptureBusy({ owner }: { owner: string }) {
  return (
    <span className="capture-label">
      <MicIcon size={14} /> {owner} — transcribing on this Mac…
    </span>
  );
}

function CapturePartial({ s }: { s: WSState }) {
  if (!s.dictPartial || s.dictOwner === "composer") return null;
  return (
    <span className="capture-partial" dir="auto">
      {s.dictPartial}
    </span>
  );
}

function CaptureRecording({ s, elapsed, owner }: { s: WSState; elapsed: number; owner: string }) {
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <>
      <span className="capture-label rec">
        <span className="rec-dot pulsing" /> {owner} · {mm}:{ss}
      </span>
      {/* Live partial transcript for the non-composer mics (the composer
          paints its partials into the box itself). Voice notes have no
          partials — the span just stays empty for them. */}
      <CapturePartial s={s} />
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
  );
}

function CaptureDock({ s }: { s: WSState }) {
  const elapsed = useCaptureElapsed(s.dictState === "recording");
  if (s.dictState === "idle") return null;
  const owner = captureOwner(s);
  const contents = {
    preparing: <CapturePreparing />,
    busy: <CaptureBusy owner={owner} />,
    recording: <CaptureRecording s={s} elapsed={elapsed} owner={owner} />,
  }[s.dictState];
  return (
    <div className={`capture-dock ${s.dictState}`} role="status">
      {contents}
    </div>
  );
}

/** Roving keyboard focus for a pop-up menu built from plain buttons.
 *
 * The file "•••" menu could be OPENED from the keyboard and then not used: it
 * took no focus and answered no arrow keys, which put Rename, Move to… and
 * Remove — which exist nowhere else — out of reach for keyboard and
 * screen-reader users. Same behaviour the QuickActions menu already has. */
const MENU_INDEXERS: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

function moveMenuFocus(
  key: string,
  count: number,
  setFocusIdx: (value: (index: number) => number) => void,
) {
  const indexer = MENU_INDEXERS[key];
  if (!indexer) return false;
  setFocusIdx((index) => indexer(index, count));
  return true;
}

export function useMenuKeys(
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
    const count = ref.current?.querySelectorAll('[role="menuitem"]:not(:disabled)').length ?? 0;
    if (count === 0) return;
    if (moveMenuFocus(e.key, count, setFocusIdx)) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
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
export function ApproveCard({
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
export function buildPaletteActions(
  s: WSState,
  a: WSActions,
  layout: LayoutApi | undefined,
  openSealedExport: () => void,
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
    { id: "go-files", label: "Open Library", hint: "Add, find, organize, and remove room files", run: () => { leaveAreas(); s.setArea("files"); s.setLibraryTab("browse"); layout?.showPane("library"); } },
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
    // ----- surfaces that live inside a pane, not at an area -----
    //
    // Same argument as the destinations above, one level down: these three are
    // tabs of the library and assistant columns, so with that column collapsed
    // there was no keyboard route to them at all and none `uiSnapshot()` could
    // see. Each one shows its pane first, because a tab selected inside a
    // hidden column is a click that appears to do nothing.
    { id: "pane-trash", label: "Open the Trash", hint: "Files deleted from this room — restorable", run: () => { leaveAreas(); s.setArea("home"); s.setLibraryTab("trash"); layout?.showPane("library"); } },
    { id: "pane-studio", label: "Open Studio", hint: "Things the assistant can make from this room", run: () => { s.setAiTab("studio"); layout?.showPane("ai"); } },
    { id: "pane-activity", label: "Open Activity", hint: "Background jobs, approvals, and the run log", run: () => { s.setAiTab("activity"); layout?.showPane("ai"); } },
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
    { id: "sealed-backup", label: "Create sealed backup…", hint: "One encrypted .arcelle file with documents and private history", run: openSealedExport },
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
  const LAYOUT_ROWS = /^(toggle-library|toggle-assistant|focus-editor|preset-|reset-layout|pane-)/;
  if (!layout) return acts.filter((x) => !LAYOUT_ROWS.test(x.id));
  return acts;
}

/** The group ⌘T's row is spliced into. Named once so the splice below cannot
 * quietly stop matching if this heading is ever reworded. */
const AROUND_THE_ROOM = "Around the room";

/** Every keyboard shortcut this app answers, grouped the way the user meets
 * them. The app had over a dozen and no way to learn one except hovering the
 * right button; this sheet is the list. Keep it in step with the real handlers:
 * effects.ts (app), Workspace.tsx (tabs), useLayout.ts (panes), chatActions.ts
 * (composer), CodeEditor.tsx (save), PdfView.tsx and SketchView.tsx (zoom),
 * SketchView.tsx (drawing), BookView.tsx / SheetView.tsx / RecordingView.tsx
 * (reading), Sidebar.tsx and BrowserSearch.tsx (the library and the browser). */
const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  {
    group: AROUND_THE_ROOM,
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
      // In `closeItemHere`'s own order (Workspace.tsx). Naming only the tab
      // described a key that closes the WINDOW — in Memory, Skills, Connectors
      // or an empty Sketch, that is all it can close — as a harmless one.
      ["⌘W", "Close the page, document or tab you are in — the window when there is none"],
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
    group: "Reading",
    rows: [
      // ⌘+/⌘-/⌘0 was filed under the PDF alone, which read as a promise that
      // the drawing did not answer it. SketchView.tsx:1315-1329 does.
      ["⌘+ / ⌘- / ⌘0", "Zoom in, out, or fit — in a PDF or a drawing"],
      ["← / →,  PageUp / PageDown", "Previous or next page of a book"],
      // SheetView binds these on the cell only when `editable` — a spreadsheet
      // opened to read has tabIndex -1 cells and answers no key at all.
      ["Arrows", "Move between cells, in a spreadsheet opened for editing"],
      ["Enter  /  F2", "Edit the cell you are on"],
      ["← / →,  Home / End", "Move between a recording's tabs"],
    ],
  },
  {
    group: "Drawing",
    rows: [
      ["V P R O A T E", "Pick a tool: select, pen, rectangle, ellipse, arrow, text, eraser"],
      ["Arrows  /  ⇧Arrows", "Nudge the selection by a point, or by a grid square"],
      ["⌘Z  /  ⇧⌘Z", "Undo or redo the drawing"],
      ["⌘A  /  ⌘D", "Select everything, or duplicate the selection"],
      ["⌘]  /  ⌘[", "Bring forward or send back (⇧ sends it all the way)"],
      ["⌫", "Delete the selection"],
    ],
  },
  {
    group: "The Library and the browser",
    rows: [
      ["⌘A", "Select every file — while the sidebar has the pointer or focus"],
      ["Esc", "Clear the file selection"],
      ["⌫", "Close the browser page row you are on"],
      ["J  /  K", "Next or previous result on a browser search page"],
    ],
  },
];

/** The keyboard-shortcuts sheet. Reuses the settings modal's frame so it is
 * dismissed exactly like every other sheet in the app. */
function ShortcutsSheet({
  area,
  webOn,
  onClose,
}: {
  area: WorkArea;
  webOn: boolean;
  onClose: () => void;
}) {
  // ⌘T is the only key whose MEANING depends on where you are — new page, new
  // sketch, new creation — which is why it was left out of a static table and
  // so out of the list the app calls complete, while its ⇧⌘T counterpart was
  // listed. In the Browser it is the primary verb, and a reader of this sheet
  // concluded it did nothing. Omitted, still, where it really does nothing —
  // including the offline room, whose ⌘T declines to open a page it cannot
  // have (the same condition `newItemHere` in Workspace.tsx returns on).
  const groups = useMemo(() => {
    const newLabel =
      newItemOf(area) === "page" && !webOn ? null : newItemLabel(area);
    if (!newLabel) return SHORTCUTS;
    return SHORTCUTS.map((sec) =>
      sec.group === AROUND_THE_ROOM
        ? { ...sec, rows: [["⌘T", newLabel] as [string, string], ...sec.rows] }
        : sec,
    );
  }, [area, webOn]);
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
          {groups.map((sec) => (
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
  const [showSealedExport, setShowSealedExport] = useState(false);
  return (
    <>
      <CaptureDock s={s} />
      {showSealedExport && <SealedExportDialog onClose={() => setShowSealedExport(false)} pushToast={s.pushToast} />}
      {s.showShortcuts && <ShortcutsSheet area={s.area} webOn={s.webOn} onClose={() => s.setShowShortcuts(false)} />}
      <ApprovalOverlays s={s} a={a} />
      <ContextMenuOverlay s={s} a={a} />
      <MoveMenuOverlay s={s} a={a} />
      <DragOverlay active={s.dragOver} />
      <SearchOverlay s={s} a={a} layout={layout} openSealedExport={() => setShowSealedExport(true)} />
    </>
  );
}
