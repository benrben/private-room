import { useCallback, useEffect, useRef } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { Props, WorkArea } from "./workspace/types";
import { useTabs, tabId, type Tab } from "./workspace/tabs";
import TabStrip from "./shell/TabStrip";
import { areaLabel } from "./shell/ActivityRail";
import { displayName } from "./workspace/composer";
import { FilesIcon, GlobeIcon } from "./icons";
import { api } from "./api";
import { useWorkspaceState } from "./workspace/state";
import { useWorkspaceActions, type WSActions } from "./workspace/actions";
import { useWorkspaceEffects } from "./workspace/effects";
import Overlays from "./workspace/Overlays";
import TopBar from "./workspace/TopBar";
import StudioModal from "./workspace/StudioModal";
import CompareModal from "./workspace/CompareModal";
import AiActionModal from "./workspace/AiActionModal";
import FeedbackModal from "./workspace/FeedbackModal";
import SettingsModals from "./workspace/SettingsModals";
import LibraryPane from "./workspace/Sidebar";
import ViewerPane from "./workspace/ViewerPane";
import AiPane from "./workspace/AiPane";
import Toasts from "./workspace/Toasts";
import { useLayout } from "./shell/useLayout";
import ActivityRail from "./shell/ActivityRail";
import Splitter from "./shell/Splitter";
import StatusBar from "./shell/StatusBar";
import ErrorBoundary from "./shell/ErrorBoundary";
import { pendingApprovalCount, runningJobCount } from "./shell/activity";
import { shouldRestoreFocus } from "./shell/tabsync";
import { isCloudEngine } from "./workspace/markup";

/** The room workspace. A thin shell: state in useWorkspaceState, handlers in
 * useWorkspaceActions, backend-event wiring in useWorkspaceEffects — composed
 * into the full-window frame: top bar / activity rail / resizable three-pane
 * grid (Library | workspace | AI) / status bar. */
export default function Workspace({ info, onLock }: Props) {
  const s = useWorkspaceState(info);
  const actions = useWorkspaceActions(s, info, onLock);

  /** Locking unmounts Monaco, and its buffer goes with it. The deliberate
   * lock (the Lock button / ⌘L / the palette) asks first; the IDLE autolock
   * deliberately does NOT — nobody is at the keyboard to answer, and a dialog
   * that held the room open until someone came back would defeat the whole
   * point of locking on idle. That is why the guard wraps the ACTION and
   * `onLock` is handed on untouched (effects.ts calls it directly for the
   * autolock).
   *
   * It has to sit in FRONT of `handleLock` rather than behind it: handleLock
   * cancels the streaming answer and plays the seal sound before it locks, so
   * asking afterwards meant "Cancel" left the room open with the answer
   * already killed and a lock sound played for a lock that never happened. */
  const handleLock = useCallback(async () => {
    if (s.editModeRef.current && s.editorDirtyRef.current) {
      const go = await confirm(
        "This file has edits you haven't saved yet. Locking the room closes the editor and loses them.",
        { title: "Unsaved edits", kind: "warning", okLabel: "Lock and discard" },
      ).catch(() => false);
      if (!go) return;
      s.editorDirtyRef.current = false;
    }
    await actions.handleLock();
  }, [s, actions]);

  const a: WSActions = { ...actions, handleLock };
  useWorkspaceEffects(s, a, info, onLock);
  const layout = useLayout(info.name);

  // ...and the same question on the way out of the app. Closing the window is
  // the one exit that never passes through the lock path, so it asks here.
  // Anything unexpected (no dialog available, a rejected prompt) lets the
  // close proceed — a door that can't be answered must never trap the user.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (e) => {
      // Registering ANY close listener makes the Rust side prevent every
      // native close and hand it to JS (tauri calls `prevent_close` whenever a
      // window has a JS listener), so from here on this handler owns closing
      // the window — including when there is nothing to ask about.
      e.preventDefault();
      if (s.editModeRef.current && s.editorDirtyRef.current) {
        const go = await confirm(
          "This file has edits you haven't saved yet. Quitting Arcelle loses them.",
          { title: "Unsaved edits", kind: "warning", okLabel: "Quit and discard" },
        ).catch(() => true);
        if (!go) return;
        s.editorDirtyRef.current = false;
      }
      // `destroy()` is the documented move, but it needs
      // core:window:allow-destroy and this app's capability grants only
      // core:default (+ set-title) — the ACL rejects it and the window simply
      // stops closing. Quitting the process is the same thing for a
      // single-window app (closing the last window exits it anyway) and runs
      // the same RunEvent::Exit teardown, so it is the fallback. Both denied
      // has to be loud: a red button that does nothing is the worst outcome.
      await win
        .destroy()
        .catch(() => exit(0))
        .catch((err) => {
          console.error("[shell] couldn't close the window:", err);
          s.pushToast("error", "Couldn't close the window — use Arcelle → Quit.");
        });
    });
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
    // Mount-once: the handler reads refs only, while `s` is a fresh object
    // every render — re-registering per render costs two IPC round-trips each
    // time, and because the removal is asynchronous the outgoing listener is
    // still live while the incoming one is added, which is two "Unsaved edits"
    // dialogs on one close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The rail's current area: full-pane flag views win, then the soft areas.
  const area: WorkArea = s.showWorkflows
    ? "workflows"
    : s.showScripts
      ? "scripts"
      : s.showMap
        ? "map"
        : s.area;

  const tabs = useTabs(info.name);
  // Which tab's state has already been put into effect. Declared up here
  // because closing a tab has to forget it: re-activating the SAME tab id
  // would otherwise skip the apply below and leave an empty pane.
  const appliedRef = useRef("");
  // The tab list as of the latest render, for callbacks that run a tick later.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /** Put the app into the state a tab describes. The tab list is the source of
   * truth; these flags are the machinery it drives. */
  const showArea = useCallback(
    (next: Exclude<WorkArea, "files">) => {
      // Leaving a full-pane view is explicit; entering one uses its real
      // action so refresh side-effects keep firing.
      if (next === "workflows") {
        s.setArea("files");
        a.openWorkflows();
        return;
      }
      if (next === "scripts") {
        s.setArea("files");
        a.openScripts();
        return;
      }
      s.setShowWorkflows(false);
      s.setShowScripts(false);
      if (next === "map") {
        s.setArea("files");
        s.setOpenFile(null);
        s.setShowMap(true);
        return;
      }
      s.setShowMap(false);
      s.setOpenFile(null);
      s.setArea(next);
      if (next === "memory") s.setShowMemoryIntro(false);
    },
    [a, s],
  );

  /** Monaco holds ONE buffer — the tab that is showing. Switching away unmounts
   * it, so an unsaved edit would go with it. Same guard the stale-file banner
   * and the Run button already use, rather than a second rule to learn. */
  const unsavedEdits = useCallback(() => {
    if (!s.editMode || !s.editorDirtyRef.current) return false;
    s.pushToast("info", "Save your edits first — or undo them — before switching tabs.");
    return true;
  }, [s]);

  const activateTab = useCallback(
    (id: string) => {
      if (id !== tabs.activeId && unsavedEdits()) return;
      tabs.activate(id);
    },
    [tabs, unsavedEdits],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (id === tabs.activeId && unsavedEdits()) return;
      const tab = tabs.tabs.find((t) => t.id === id);
      if (tab?.kind === "page") void api.browserCloseTab(tab.ref).catch(() => {});
      // Closing the tab must close what it was SHOWING, or the file stays on
      // screen with no tab pointing at it — and the watcher below would hand
      // it a new tab on the next file-list refresh.
      if (tab?.kind === "file" && tab.ref === s.openFile?.id) s.setOpenFile(null);
      // Forget that this tab's state was applied: re-opening the same id later
      // has to put the app back into it, not skip as a no-op switch.
      if (appliedRef.current === id) appliedRef.current = "";
      tabs.close(id);
    },
    [tabs, unsavedEdits, s],
  );

  // Pages the USER asked for (⌘T, the ＋ button) that the tab strip has not
  // caught up with yet. The reconciliation below has to tell them apart from
  // pages the ASSISTANT opened, and a poll can see one of these before React
  // has committed its tab; entries are dropped the moment page and tab agree.
  const localPagesRef = useRef(new Set<string>());

  const newBrowserPage = useCallback(() => {
    // A new page shows the Browser area, which closes the open file and takes
    // Monaco's buffer with it. Same guard as the strip, ⌘W and ⌥⌘1–9 — ⌘T and
    // the ＋ button were the one pair that walked straight past it.
    if (unsavedEdits()) return;
    void api
      .browserNewTab("")
      .then((id) => {
        localPagesRef.current.add(id);
        tabs.open("page", id, "New page");
      })
      .catch((e) => s.pushToast("error", String(e)));
  }, [tabs, s, unsavedEdits]);

  // The strip mirrors what Rust actually has open, in both directions: a page
  // the AGENT opened earns a tab, a page that went away loses one, and titles
  // follow navigation. Polled rather than evented because the page's own
  // `<title>` changes without any navigation firing — but only at the brisk
  // rate while the Browser is the visible area; anywhere else in the app this
  // is just a background reconciliation and a lazy tick is plenty.
  useEffect(() => {
    if (!s.webOn) return;
    let stop = false;
    const sync = async () => {
      const live = await api.browserTabs().catch(() => null);
      if (stop || !live) return;
      const ids = new Set(live.map((p) => p.id));
      // What is showing right now, and whether it survives this reconciliation.
      const showing = tabs.tabs.find((t) => t.id === tabs.activeId);
      const showingLives =
        showing != null && (showing.kind !== "page" || ids.has(showing.ref));
      tabs.prune((t) => t.kind !== "page" || ids.has(t.ref));
      const adopted: string[] = [];
      for (const page of live) {
        const id = tabId("page", page.id);
        if (tabs.tabs.some((t) => t.id === id)) {
          tabs.retitle(id, page.title);
          // It has both a tab and a page now, so it can never be adopted
          // again: the set only ever holds the ones still in flight.
          localPagesRef.current.delete(page.id);
        } else {
          tabs.open("page", page.id, page.title);
          adopted.push(page.id);
        }
      }
      // `open` focuses, which is right when the USER opens a page and wrong
      // when the assistant opens one in the background: a page discovered
      // here must never yank the reader out of a file (or an edit). The tab
      // appears quietly; going to it stays the user's move. A page the user
      // asked for is not a discovery, though — this poll can land after ⌘T
      // created the page and before React has committed its tab, and treating
      // it as the assistant's would leave the user's own new page unfocused.
      if (shouldRestoreFocus(adopted, localPagesRef.current, showingLives))
        tabs.activate(tabs.activeId);
    };
    void sync();
    const timer = window.setInterval(() => void sync(), area === "browser" ? 1200 : 5000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.webOn, area, tabs.tabs.length, tabs.activeId]);

  // Rail click = focus-or-open, which is what makes an area STAY open.
  const openArea = useCallback(
    (next: Exclude<WorkArea, "files">) => {
      if (unsavedEdits()) return;
      tabs.open("area", next, areaLabel(next));
    },
    [tabs, unsavedEdits],
  );

  // Every existing `setOpenFile` call site — citations, agent opens, the
  // library, Quick Actions, 21 of them — earns a tab for free by being watched
  // here instead of edited individually.
  const openFileId = s.openFile?.id ?? "";
  // The file this watcher last handed a tab to. Without it every file-list
  // refresh re-ran `open` for the file still marked open — which RE-CREATED
  // the tab the user had just closed, and stole focus with it.
  const tabbedFileRef = useRef("");
  useEffect(() => {
    if (!openFileId) {
      tabbedFileRef.current = "";
      return;
    }
    const name = s.files.find((f) => f.id === openFileId)?.name ?? "File";
    if (tabbedFileRef.current === openFileId) {
      // Same file, refreshed list: the only thing that can have changed is its
      // name (a rename), so keep the strip honest without touching focus.
      tabs.retitle(tabId("file", openFileId), displayName(name));
      return;
    }
    tabbedFileRef.current = openFileId;
    tabs.open("file", openFileId, displayName(name));
    // `tabs` is stable per render by identity of its callbacks; keying on the
    // file id is what makes this fire once per open rather than every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFileId, s.files]);

  // ...and the other direction: showing a tab puts the app into its state.
  // Guarded by the id so this runs on a real switch, never on every render.
  useEffect(() => {
    const tab = tabs.active;
    if (!tab || appliedRef.current === tab.id) return;
    appliedRef.current = tab.id;
    if (tab.kind === "file") {
      if (tab.ref !== s.openFile?.id) void a.viewFile(tab.ref);
      return;
    }
    if (tab.kind === "area") {
      showArea(tab.ref as Exclude<WorkArea, "files">);
      return;
    }
    // A browser page: the Browser area shows whichever page is active, so the
    // area switch and the page switch are the same move.
    void api.browserSelectTab(tab.ref).catch(() => {});
    if (s.area !== "browser") showArea("browser");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.active?.id]);

  // The full-pane views (Scripts, Workflows, Room Map) are flags, and they can
  // be raised or dropped from outside the strip: a toast action, the ⌘K
  // palette, the page's own Close button, Escape. Both directions have to
  // reach the strip, or the tab and the pane disagree — closing Scripts from
  // inside it used to leave its tab selected over an empty pane, and clicking
  // that tab did nothing, because the state it describes was already
  // "applied".
  const areaFlagsRef = useRef({ scripts: false, workflows: false, map: false });
  useEffect(() => {
    const prev = areaFlagsRef.current;
    const now = {
      scripts: s.showScripts,
      workflows: s.showWorkflows,
      map: s.showMap,
    };
    areaFlagsRef.current = now;
    const keys = ["scripts", "workflows", "map"] as const;
    // Raised: make sure the view that is on screen owns the selected tab —
    // the "Scripts" action on a run toast opens the page directly.
    for (const key of keys) {
      if (!prev[key] && now[key]) tabs.open("area", key, areaLabel(key));
    }
    const fell = keys.filter((key) => prev[key] && !now[key]);
    if (fell.length === 0) return;
    // Dropped: wait a tick before deciding. Leaving one view for another (a
    // file, a different area) drops this flag too, and whatever takes over
    // brings its own tab — only a view dismissed with nothing replacing it
    // leaves its tab pointing at an empty pane.
    const t = window.setTimeout(() => {
      const live = tabsRef.current;
      for (const key of fell) {
        const id = tabId("area", key);
        if (live.activeId !== id) continue;
        if (appliedRef.current === id) appliedRef.current = "";
        live.close(id);
      }
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.showScripts, s.showWorkflows, s.showMap]);

  // A tab whose file was deleted has nothing to show.
  useEffect(() => {
    if (!s.files.length) return;
    const alive = new Set(s.files.map((f) => f.id));
    tabs.prune((t) => t.kind !== "file" || alive.has(t.ref));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.files]);

  // Tab keys. Every switch goes through the same unsaved-edits guard the strip
  // itself uses — a shortcut that quietly threw away typing was the one hole.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      // ⌥⌘1–⌥⌘9 pick a tab by position. Plain ⌘1/2/3 belong to the pane
      // toggles (useLayout, and the rail says so out loud) — both handlers
      // used to fire, so one press collapsed a pane AND jumped tabs. Read off
      // `code`, because Option rewrites `key` into ¡™£ on macOS.
      if (e.altKey) {
        const digit = /^Digit([1-9])$/.exec(e.code);
        if (!digit) return;
        e.preventDefault();
        if (unsavedEdits()) return;
        tabs.activateIndex(Number(digit[1]) - 1);
        return;
      }
      if (e.key === "w" && tabs.activeId) {
        e.preventDefault();
        closeTab(tabs.activeId);
        return;
      }
      // With Shift held the bracket keys report as "}" / "{" — checking only
      // the unshifted characters meant these never fired at all.
      if (e.shiftKey && (e.key === "]" || e.key === "}")) {
        e.preventDefault();
        if (unsavedEdits()) return;
        tabs.step(1);
        return;
      }
      if (e.shiftKey && (e.key === "[" || e.key === "{")) {
        e.preventDefault();
        if (unsavedEdits()) return;
        tabs.step(-1);
        return;
      }
      // ⌘T — the promise the ＋ button's tooltip has always made.
      if (e.key === "t" && !e.shiftKey && s.webOn) {
        e.preventDefault();
        newBrowserPage();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, closeTab, unsavedEdits, newBrowserPage, s.webOn]);

  const tabIcon = useCallback(
    (tab: Tab) =>
      tab.kind === "page" ? <GlobeIcon size={12} /> : <FilesIcon size={12} />,
    [],
  );

  // One definition of "waiting" and "running" for the whole shell (see
  // shell/activity.ts) — the status bar and the Activity tab used to count
  // separately and disagree for a second after a recording stopped.
  const pendingApprovals = pendingApprovalCount(s);
  const runningJobs = runningJobCount(s);

  const showActivity = useCallback(() => {
    s.setAiTab("activity");
    layout.showPane("ai");
  }, [s, layout]);

  return (
    <div className="workspace">
      <Overlays s={s} a={a} layout={layout} />
      <Toasts toasts={s.toasts} dismissToast={s.dismissToast} />
      <TopBar s={s} a={a} info={info} layout={layout} />

      <StudioModal s={s} a={a} />
      <CompareModal s={s} a={a} />
      <AiActionModal s={s} a={a} />
      {/* Mounted only while open: the draft fields are local state, so
          unmounting is what clears them between issues (GH #3). */}
      {s.showFeedback && <FeedbackModal s={s} />}
      {/* A settings screen that throws must not take the room down with it. */}
      <ErrorBoundary scope="Settings">
        <SettingsModals s={s} a={a} info={info} />
      </ErrorBoundary>

      <main className="pr-main">
        <ActivityRail
          layout={layout}
          area={area}
          onArea={openArea}
          onSearch={() => {
            s.setSearchSel(0);
            s.setShowSearch(true);
          }}
          onSettings={() => s.setShowSettings(true)}
          aiAttention={pendingApprovals > 0 || runningJobs > 0}
        />
        <div
          className={`pane-grid${layout.dragging ? " is-dragging" : ""}`}
          ref={layout.gridRef}
          style={layout.gridStyle}
        >
          <section
            className={`pane pane-library${layout.visible.includes("library") ? "" : " is-hidden"}`}
            aria-label="Library and sources"
            aria-hidden={!layout.visible.includes("library")}
          >
            <ErrorBoundary scope="The library">
              <LibraryPane s={s} a={a} layout={layout} area={area} />
            </ErrorBoundary>
          </section>
          <Splitter side="a" layout={layout} label="Resize the Library pane" />
          <section
            className={`pane pane-center${layout.visible.includes("center") ? "" : " is-hidden"}`}
            aria-label="Workspace"
            aria-hidden={!layout.visible.includes("center")}
          >
            <TabStrip
              tabs={{ ...tabs, activate: activateTab, close: closeTab }}
              icons={tabIcon}
              onNewPage={s.webOn ? newBrowserPage : null}
            />
            {/* The viewers have their own chunk boundary; this one covers the
                rest of the centre pane — the browser, workflows, scripts and
                the map — which had no net at all. */}
            <ErrorBoundary scope="The workspace pane">
              <ViewerPane s={s} a={a} info={info} layout={layout} area={area} />
            </ErrorBoundary>
          </section>
          <Splitter side="b" layout={layout} label="Resize the AI pane" />
          <section
            className={`pane pane-ai${layout.visible.includes("ai") ? "" : " is-hidden"}`}
            aria-label="AI chat, Studio, and activity"
            aria-hidden={!layout.visible.includes("ai")}
          >
            <ErrorBoundary scope="The AI pane">
              <AiPane s={s} a={a} info={info} layout={layout} area={area} />
            </ErrorBoundary>
          </section>
        </div>
      </main>

      <StatusBar
        layout={layout}
        fileCount={s.files.length}
        cloud={isCloudEngine(s.model)}
        engineLabel={a.engineLabelOf(s.model)}
        protectedOn={s.privacyOn}
        onOpenPrivacy={() => {
          s.setSettingsSection("set-cloud-privacy");
          s.setShowSettings(true);
        }}
        webOn={s.webOn}
        mcpToolCount={s.mcpTools.length}
        runningJobs={runningJobs}
        pendingApprovals={pendingApprovals}
        onShowActivity={showActivity}
      />
    </div>
  );
}
