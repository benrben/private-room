import { useCallback, useEffect, useRef, useState } from "react";
import { closeWindow, confirm } from "./platform";
import { Props, WorkArea, areaHoldsFile, isWorkArea } from "./workspace/types";
import { useTabs, type Tab } from "./workspace/tabs";
import { useBrowserPages } from "./workspace/browserPages";
import {
  newItemOf,
  sidebarMenuLabel,
  type NewItemKind,
} from "./workspace/destinations";
import { libraryFiles } from "./workspace/fileVisibility";
import type { TabTitleFacts } from "./shell/TabStrip";
import { api, fileKindLabel } from "./api";
import { useWorkspaceState } from "./workspace/state";
import { useWorkspaceActions, type WSActions } from "./workspace/actions";
import { useWorkspaceEffects } from "./workspace/effects";
import TopBar from "./workspace/TopBar";
import { useLayout } from "./shell/useLayout";
import { useNativeMenu } from "./shell/useNativeMenu";
import StatusBar from "./shell/StatusBar";
import { pendingApprovalCount, runningJobCount } from "./shell/activity";
import { isCloudRoute } from "./workspace/markup";
import {
  AREA_SETTING,
  FOCUSED_KINDS,
  WorkspaceModals,
  WorkspacePanes,
  WorkspaceReadOnlyBanner,
  handleWorkspaceTabKeydown,
  rememberedFileForArea,
  restoreRememberedFile,
  syncOpenFileTab,
  workspaceArea,
} from "./workspaceShell";
export default function Workspace({ info, onLock, onRenamed }: Props) {
  const [registeringCopy, setRegisteringCopy] = useState(false);
  const s = useWorkspaceState(info);
  const actions = useWorkspaceActions(s, info, onLock);
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
  // The PATH, not the name: the saved-layout key is a digest of it, so no room
  // name lands in plain browser storage and two same-named rooms in different
  // folders stop sharing (and overwriting) one layout.
  const layout = useLayout(info.path);
  // The "Customize sidebar" sheet. Local to the shell rather than in
  // `useWorkspaceState`: nothing outside this component raises it, and the
  // preferences it edits are their own device-wide store (shell/navPrefs).
  const [showCustomize, setShowCustomize] = useState(false);
  const openCustomizeSidebar = useCallback(() => setShowCustomize(true), []);
  // ⌘Q raises NO window close request on macOS (the menu's Quit goes through
  // NSApplication terminate:, and tao only emits CloseRequested from
  // windowShouldClose:), so the guard above never sees it and the buffer went
  // out with the process. Rust holds that quit instead — but the handler is
  // synchronous and cannot ask, so it needs the answer in advance.
  //
  // Polled rather than pushed from each mutation site: `editorDirtyRef` is a
  // ref written from eight places (typing, saving, discarding, locking, the
  // viewer unmounting), and a guard that is only as good as the site that
  // forgot to call it is not a guard. One IPC per CHANGE, never per tick.
  useEffect(() => {
    let sent: boolean | null = null;
    const push = () => {
      const dirty = s.editModeRef.current && s.editorDirtyRef.current;
      if (dirty === sent) return;
      sent = dirty;
      void api.setUnsavedEdits(dirty).catch(() => {});
    };
    push();
    const timer = window.setInterval(push, 400);
    // ...and the question itself, asked here because only this window knows
    // how to ask it. Whoever answers OWNS the quit: Rust holds it once.
    const unlisten = api.onQuitRequested(async () => {
      const go = await confirm(
        "This file has edits you haven't saved yet. Quitting Arcelle loses them.",
        { title: "Unsaved edits", kind: "warning", okLabel: "Quit and discard" },
      ).catch(() => true);
      if (!go) {
        // Staying. The buffer is still dirty, so the flag must NOT be cleared —
        // but Rust latched this quit as "already asked", and left alone that
        // latch lets the next ⌘Q quit with no dialog and discard the very
        // buffer this one just saved.
        await api.quitGuardRearm().catch(() => {});
        return;
      }
      s.editorDirtyRef.current = false;
      await api.setUnsavedEdits(false).catch(() => {});
      await api.quitGuardConfirm().catch(() => {});
    });
    return () => {
      window.clearInterval(timer);
      void unlisten.then((fn) => fn()).catch(() => {});
      // Leaving the room takes the editor with it — a stale "dirty" would hold
      // the next quit for a buffer that no longer exists.
      void api.setUnsavedEdits(false).catch(() => {});
    };
    // Mount-once: reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The rail's current area: full-pane flag views win, then the soft areas.
  const area = workspaceArea(s);
  const pages = useBrowserPages(s.webOn, area === "browser", (message) =>
    s.pushToast("error", message),
  );
  // Keyed on the PATH, not the display name. The name is editable from the top
  // bar, and re-keying on it made a rename read as "a different room": the tab
  // list was re-read and the area restore ran again, closing whatever
  // section-only object was open. tabs.ts's "tabs belong to a room, not to the
  // window" is about identity, and the path is what carries it.
  const tabs = useTabs(info.path);
  // Which tab's state has already been put into effect. Declared up here
  // because closing a tab has to forget it: re-activating the SAME tab id
  // would otherwise skip the apply below and leave an empty pane.
  const appliedRef = useRef("");
  // The tab list as of the latest render, for callbacks that run a tick later.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const showArea = useCallback(
    (next: WorkArea) => {
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
  const guardLeave = a.guardLeave;
  const activateTab = useCallback(
    (id: string) => {
      if (id === tabs.activeId) return;
      guardLeave("Switching tabs", () => tabs.activate(id));
    },
    [tabs, guardLeave],
  );
  const reopenableRef = useRef<string[]>([]);
  const doCloseTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.tabs.find((t) => t.id === id);
      if (tab?.kind === "file") {
        // Re-closing a file that was already reopened must not leave two
        // entries, or ⇧⌘T twice would open the same file twice.
        reopenableRef.current = reopenableRef.current
          .filter((ref) => ref !== tab.ref)
          .concat(tab.ref)
          .slice(-20);
      }
      // Closing the tab must close what it was SHOWING, or the file stays on
      // screen with no tab pointing at it — and the watcher below would hand
      // it a new tab on the next file-list refresh.
      if (tab?.kind === "file" && tab.ref === s.openFileRef.current?.id) s.setOpenFile(null);
      // Forget that this tab's state was applied: re-opening the same id later
      // has to put the app back into it, not skip as a no-op switch.
      if (appliedRef.current === id) appliedRef.current = "";
      tabs.close(id);
    },
    [tabs, s],
  );
  const closeTab = useCallback(
    (id: string) => {
      if (id !== tabs.activeId) {
        doCloseTab(id);
        return;
      }
      guardLeave("Closing this tab", () => doCloseTab(id));
    },
    [tabs.activeId, doCloseTab, guardLeave],
  );
  const newItem = useCallback(
    (kind: NewItemKind) => {
      const what =
        kind === "page"
          ? "Opening a new page"
          : kind === "sketch"
            ? "Starting a new sketch"
            : kind === "creation"
              ? "Starting a new creation"
              : "Making a new note";
      guardLeave(what, () => {
        if (kind === "page") {
          void pages.open();
          return;
        }
        if (kind === "sketch") {
          void a.createSketch();
          return;
        }
        if (kind === "creation") {
          // A creation is composed, not created: "new" means an empty composer
          // with nothing selected, which is exactly what the Create page shows
          // when no creation is open. The bump is what tells it to clear a
          // half-written prompt — see `newCreationSeq` in state.ts.
          s.setOpenFile(null);
          s.bumpNewCreation();
          return;
        }
        void a.createNewNote();
      });
    },
    [guardLeave, pages, a, s],
  );
  const newItemHere = useCallback(() => {
    const kind = newItemOf(area);
    if (!kind || (kind === "page" && !s.webOn)) return;
    newItem(kind);
  }, [area, s.webOn, newItem]);
  const closeItemHere = useCallback(() => {
    if (area === "browser" && pages.activeId) {
      pages.close(pages.activeId);
      return;
    }
    if (tabsRef.current.activeId) {
      closeTab(tabsRef.current.activeId);
      return;
    }
    if (s.openFileRef.current) {
      guardLeave("Closing this file", () => s.setOpenFile(null));
      return;
    }
    void closeWindow();
  }, [area, pages, closeTab, guardLeave, s]);
  // Rail click = go there. Places used to earn a TAB as well, which is what
  // made the strip fill up with the same nine names the rail already lists;
  // the rail is now the only navigation and the strip holds documents (see
  // shell/ActivityRail.tsx for why that way round). Nothing is lost by not
  // having a tab: the area is held by `s.area` and the view flags, an open
  // file simply draws on top of it, and closing that file returns to the area
  // underneath exactly as it did when a tab was doing the remembering.
  //
  // Except for one thing, which is why AREA_SETTING exists. A tab was also
  // doing the remembering ACROSS LAUNCHES. Once areas stopped being tabs the
  // room had nowhere to record which place the reader was in, so quitting on
  // Home and reopening landed them on a file instead. The area is written here
  // — at the one entry point a person actually navigates through — and read
  // back below.
  // …and the same two verbs on the menu bar, which is where macOS looks for
  // ⌘T and ⌘W — and, while the private browser's native webview holds key
  // focus, the only place that hears them at all. The layout menu rides along
  // (it owns ⌘1 and ⌘2 for the same reason; see PANE_KEYS).
  // The View menu's ⌘1 row is named after the column it toggles — `sidebar`
  // rides along with the ticks for that reason, since the menu bar is not part
  // of this window and nothing else can keep its wording honest.
  const sidebarTitle = sidebarMenuLabel(area);
  useNativeMenu(layout, sidebarTitle, {
    newItem: newItemHere,
    closeItem: closeItemHere,
  });
  const lastFileRef = useRef<Partial<Record<WorkArea, string>>>({});
  const openArea = useCallback(
    (next: WorkArea) => {
      guardLeave("Opening this area", () => {
        // Remember what was open HERE before leaving — but only if this
        // destination actually held it. A document showing over a destination
        // that does not own it has already been moved Home by `showFileHere`
        // below, so this can never file a stray under the wrong place.
        lastFileRef.current[area] = rememberedFileForArea(area, s);
        showArea(next);
        void api.setSetting(AREA_SETTING, next).catch(() => {
          /* a forgotten place is cosmetic; never disturb the room over it */
        });
        // ...and the strip selects NOTHING. Going to a place closes the open
        // file, so leaving its tab highlighted would have the strip claiming
        // to show a document that is no longer on screen — and clicking that
        // highlight would do nothing, because the state it describes is
        // already "applied". Forgetting the applied id is the other half:
        // clicking the tab again has to genuinely re-open the file.
        appliedRef.current = "";
        tabs.activate("");
        // Put back whatever this destination was last showing. Checked against
        // the live file list, because a document deleted while you were
        // elsewhere must not reopen — and skipped for the browser, whose
        // selection is a live page and is restored by `useBrowserPages`.
        restoreRememberedFile(next, lastFileRef, s.files, a.viewFile);
      });
    },
    [showArea, guardLeave, tabs, area, s, a],
  );
  const areaRestoredFor = useRef("");
  useEffect(() => {
    if (!tabs.restored || areaRestoredFor.current === info.path) return;
    areaRestoredFor.current = info.path;
    if (tabs.activeId) return;
    void api
      .getSetting(AREA_SETTING)
      .then((saved) => {
        if (saved && isWorkArea(saved)) showArea(saved);
      })
      .catch(() => {
        /* opens at the default place, which is a fine outcome */
      });
  }, [tabs.restored, tabs.activeId, info.path, showArea]);
  // Every existing `setOpenFile` call site — citations, agent opens, the
  // library, Quick Actions, 21 of them — earns a tab for free by being watched
  // here instead of edited individually.
  const openFileId = s.openFile?.id ?? "";
  // The file this watcher last handed a tab to. Without it every file-list
  // refresh re-ran `open` for the file still marked open — which RE-CREATED
  // the tab the user had just closed, and stole focus with it.
  const tabbedFileRef = useRef("");
  useEffect(() => {
    syncOpenFileTab({ files: s.files, openFileId, tabbedFileRef, tabs });
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
    // Legacy only: rooms saved before places stopped being tabs still have
    // area tabs in their settings, and this is the tick between them being
    // read back and the prune below dropping them. Applying it keeps that tick
    // honest — the room opens where it was left.
    showArea(tab.ref as WorkArea);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.active?.id]);
  useEffect(() => {
    const open = s.openFile;
    if (!open) return;
    const known = s.files.some((f) => f.id === open.id);
    if (!known || areaHoldsFile(area, open.id, s.files, s.scripts)) return;
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setShowMap(false);
    s.setArea("files");
    void api.setSetting(AREA_SETTING, "home").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.openFile?.id, area, s.files, s.scripts]);
  // A full-pane view (Scripts, Workflows, Room Map) can be raised from outside
  // the rail — the "Scripts" action on a run toast, the ⌘K palette, a Home
  // row, the library's "New workflow" — and every one of those takes the pane
  // away from whatever document was on screen. Places are not tabs any more,
  // so there is nothing for the strip to select instead: it selects nothing,
  // for the same reason `openArea` does. Dropping a flag needs no handling at
  // all now — whatever the pane falls back to is an area, and areas are the
  // rail's business.
  const areaFlagsRef = useRef({ scripts: false, workflows: false, map: false });
  useEffect(() => {
    const prev = areaFlagsRef.current;
    const now = {
      scripts: s.showScripts,
      workflows: s.showWorkflows,
      map: s.showMap,
    };
    areaFlagsRef.current = now;
    const raised = (["scripts", "workflows", "map"] as const).some(
      (key) => !prev[key] && now[key],
    );
    if (!raised || !tabsRef.current.activeId) return;
    appliedRef.current = "";
    tabsRef.current.activate("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.showScripts, s.showWorkflows, s.showMap]);
  // One-time housekeeping: a room saved before places stopped being tabs has
  // area tabs in `workspace_tabs`, and they arrive a tick after mount when the
  // setting is read back. Dropping them here rewrites the setting clean.
  //
  // `unlist`, not `prune`: housekeeping must never navigate. A room whose saved
  // `activeId` WAS one of those area rows had it applied for one tick and was
  // then handed to the last file tab in the strip — so a room opened on Memory
  // landed on a document the reader might not have touched in weeks.
  useEffect(() => {
    tabs.unlist((t) => t.kind !== "area");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.tabs.length]);
  // A tab whose file was deleted has nothing to show — and neither has one
  // whose file has since been REMOVED from the Library, which is the same
  // question asked of Home's working set: the object is fine, Home is simply
  // not one of the places that lists it any more.
  //
  // `unlist`, not `prune`, and the difference is the whole point. Both drop the
  // same tab; only one of them may move the reader. Removing the sketch you are
  // drawing from the Library elected the next tab along and the apply effect
  // opened it — so a demotion, which is meant to change one row in one list,
  // silently replaced the drawing on the canvas. The object never went
  // anywhere; the strip simply stopped listing it, which is exactly what the
  // user asked for and all that may happen.
  //
  // The guard is "the list has arrived", not "the list has something in it".
  // Trashing a room's only file leaves `s.files` empty, and an early return on
  // that left the tab for the file that was just deleted: persisted, restored
  // and re-activated on the next unlock, where it produced "Could not open that
  // file" over an empty workspace and held off the saved-area restore. The room
  // path is the key so a room swap does not prune against the previous room's
  // list while the new one is still loading.
  const filesLoadedFor = useRef("");
  useEffect(() => {
    if (s.files.length) filesLoadedFor.current = info.path;
    if (filesLoadedFor.current !== info.path) return;
    const shown = new Set(libraryFiles(s.files).map((f) => f.id));
    tabs.unlist((t) => t.kind !== "file" || shown.has(t.ref));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.files, info.path]);
  // Tab keys. Every switch goes through the same unsaved-edits guard the strip
  // itself uses — a shortcut that quietly threw away typing was the one hole.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => handleWorkspaceTabKeydown(event, {
      area,
      files: s.files,
      guardLeave,
      reopenableRef,
      tabs,
      viewFile: a.viewFile,
    });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `s.files` is in here because ⇧⌘T reads it — a stale list would reopen a
    // file that has since been deleted, or skip one that has not. `area` is in
    // here because ⌘T and ⌘W are both scoped by it, and a stale area would run
    // the previous destination's verb.
  }, [tabs, closeTab, guardLeave, newItem, area, pages, s, a]);
  // A tab's glyph. None, now that the strip holds one KIND of thing: every
  // file tab used to carry the same generic sheet icon, which spent the row's
  // first 18px saying something the reader already knew and pushed the one
  // useful thing — the file's name — out of view. (The globe belonged to
  // browser pages, which have their own list now and their own icons in it.)
  const tabIcon = useCallback((_tab: Tab) => null, []);
  // B5: what a tab's model-written title (see shell/TabStrip.tsx) is
  // generated from — the file's saved name plus a short kind word, nothing
  // else. `null` opts the tab out of generation entirely rather than
  // supplying thin facts: a page/area tab has no file behind it at all, and
  // a brand-new file with `hasText: false` has nothing to say about itself
  // beyond its own filename — asking the model to paraphrase that would burn
  // a call to (at best) restate the fallback and (at worst) invent a subject
  // that isn't there. Reads `s.files` fresh each call rather than being
  // memoized on the tab; `useAdaptiveText` keys its cache on this object's
  // CONTENT, so a new-identity-same-content facts object every render is by
  // design, not a missed optimization (see adaptiveText.ts).
  const tabTitleFacts = useCallback(
    (tab: Tab): TabTitleFacts | null => {
      if (tab.kind !== "file") return null;
      const file = s.files.find((f) => f.id === tab.ref);
      if (!file || !file.hasText) return null;
      return { name: file.name, kind: fileKindLabel(file) };
    },
    [s.files],
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
  const openPrivacySettings = useCallback(() => {
    s.setSettingsSection("set-cloud-privacy");
    s.setShowSettings(true);
  }, [s]);
  // Reading and recording are one-column jobs, and the layout is told so it
  // can hand the width over once (useLayout's `setFocusedPage`). Derived here
  // rather than inside the layout because this is the only place that knows
  // both which area is showing and what kind of file is open.
  const setFocusedPage = layout.setFocusedPage;
  const focusedPage =
    area === "recordings" ||
    (s.openFile != null && FOCUSED_KINDS.has(s.openFile.content.kind));
  useEffect(() => {
    setFocusedPage(focusedPage);
  }, [focusedPage, setFocusedPage]);
  return (
    <div className="workspace">
      <WorkspaceModals
        a={a}
        info={info}
        layout={layout}
        s={s}
        showCustomize={showCustomize}
        setShowCustomize={setShowCustomize}
      />
      <TopBar
        s={s}
        a={a}
        info={info}
        layout={layout}
        sidebarTitle={sidebarTitle}
        onRenamed={onRenamed}
        // These two used to ride on the sidebar's AI pane toggle, which no
        // longer exists — the Assistant's control is in the toolbar now, and
        // so is its news. Same two definitions as the status bar (shell/
        // activity.ts), so the three surfaces can never disagree.
        approvals={pendingApprovals}
        running={runningJobs}
      />
      <WorkspaceReadOnlyBanner
        info={info}
        onRenamed={onRenamed}
        pushToast={s.pushToast}
        registeringCopy={registeringCopy}
        setRegisteringCopy={setRegisteringCopy}
      />
      <WorkspacePanes
        a={a}
        activateTab={activateTab}
        area={area}
        closeTab={closeTab}
        info={info}
        layout={layout}
        newItem={newItem}
        openArea={openArea}
        pages={pages}
        s={s}
        showCustomize={openCustomizeSidebar}
        tabIcon={tabIcon}
        tabTitleFacts={tabTitleFacts}
        tabs={tabs}
      />
      <StatusBar
        layout={layout}
        fileCount={s.files.length}
        cloud={isCloudRoute(s.model, s.ai)}
        engineLabel={a.engineLabelOf(s.model)}
        protectedOn={s.privacyOn}
        onOpenPrivacy={openPrivacySettings}
        webOn={s.webOn}
        mcpToolCount={s.mcpTools.length}
        runningJobs={runningJobs}
        pendingApprovals={pendingApprovals}
        onShowActivity={showActivity}
      />
    </div>
  );
}
