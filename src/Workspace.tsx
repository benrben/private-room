import { useCallback, useEffect, useRef } from "react";
import { Props, WorkArea } from "./workspace/types";
import { useTabs, tabId, type Tab } from "./workspace/tabs";
import TabStrip from "./shell/TabStrip";
import { areaLabel } from "./shell/ActivityRail";
import { displayName } from "./workspace/composer";
import { FilesIcon, GlobeIcon } from "./icons";
import { api } from "./api";
import { useWorkspaceState } from "./workspace/state";
import { useWorkspaceActions } from "./workspace/actions";
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
import { isCloudEngine } from "./workspace/markup";

/** The room workspace. A thin shell: state in useWorkspaceState, handlers in
 * useWorkspaceActions, backend-event wiring in useWorkspaceEffects — composed
 * into the full-window frame: top bar / activity rail / resizable three-pane
 * grid (Library | workspace | AI) / status bar. */
export default function Workspace({ info, onLock }: Props) {
  const s = useWorkspaceState(info);
  const a = useWorkspaceActions(s, info, onLock);
  useWorkspaceEffects(s, a, info, onLock);
  const layout = useLayout(info.name);

  // The rail's current area: full-pane flag views win, then the soft areas.
  const area: WorkArea = s.showWorkflows
    ? "workflows"
    : s.showScripts
      ? "scripts"
      : s.showMap
        ? "map"
        : s.area;

  const tabs = useTabs(info.name);

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
      tabs.close(id);
    },
    [tabs, unsavedEdits],
  );

  const newBrowserPage = useCallback(() => {
    void api
      .browserNewTab("")
      .then((id) => tabs.open("page", id, "New page"))
      .catch((e) => s.pushToast("error", String(e)));
  }, [tabs, s]);

  // The strip mirrors what Rust actually has open, in both directions: a page
  // the AGENT opened earns a tab, a page that went away loses one, and titles
  // follow navigation. Polled rather than evented because the page's own
  // `<title>` changes without any navigation firing.
  useEffect(() => {
    if (!s.webOn) return;
    let stop = false;
    const sync = async () => {
      const live = await api.browserTabs().catch(() => null);
      if (stop || !live) return;
      const ids = new Set(live.map((p) => p.id));
      tabs.prune((t) => t.kind !== "page" || ids.has(t.ref));
      for (const page of live) {
        const id = tabId("page", page.id);
        if (tabs.tabs.some((t) => t.id === id)) tabs.retitle(id, page.title);
        else tabs.open("page", page.id, page.title);
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 1200);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.webOn, tabs.tabs.length]);

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
  useEffect(() => {
    if (!openFileId) return;
    const name = s.files.find((f) => f.id === openFileId)?.name ?? "File";
    tabs.open("file", openFileId, displayName(name));
    // `tabs` is stable per render by identity of its callbacks; keying on the
    // file id is what makes this fire once per open rather than every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFileId, s.files]);

  // ...and the other direction: showing a tab puts the app into its state.
  // Guarded by the id so this runs on a real switch, never on every render.
  const appliedRef = useRef("");
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

  // A tab whose file was deleted has nothing to show.
  useEffect(() => {
    if (!s.files.length) return;
    const alive = new Set(s.files.map((f) => f.id));
    tabs.prune((t) => t.kind !== "file" || alive.has(t.ref));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.files]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "w" && tabs.activeId) {
        e.preventDefault();
        closeTab(tabs.activeId);
        return;
      }
      if (e.key === "]" && e.shiftKey) {
        e.preventDefault();
        tabs.step(1);
        return;
      }
      if (e.key === "[" && e.shiftKey) {
        e.preventDefault();
        tabs.step(-1);
        return;
      }
      if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
        e.preventDefault();
        tabs.activateIndex(Number(e.key) - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, closeTab]);

  const tabIcon = useCallback(
    (tab: Tab) =>
      tab.kind === "page" ? <GlobeIcon size={12} /> : <FilesIcon size={12} />,
    [],
  );

  const pendingApprovals =
    s.mcpApprovals.length +
    s.editApprovals.length +
    s.scriptApprovals.length +
    s.browseConsents.length;
  const runningJobs =
    s.jobs.filter((j) => j.status === "running" || j.status === "queued")
      .length +
    (s.summaryStarting ? 1 : 0) +
    (s.recSave ? 1 : 0);

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
      <SettingsModals s={s} a={a} info={info} />

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
            <LibraryPane s={s} a={a} layout={layout} area={area} />
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
            <ViewerPane s={s} a={a} info={info} layout={layout} area={area} />
          </section>
          <Splitter side="b" layout={layout} label="Resize the AI pane" />
          <section
            className={`pane pane-ai${layout.visible.includes("ai") ? "" : " is-hidden"}`}
            aria-label="AI chat, Studio, and activity"
            aria-hidden={!layout.visible.includes("ai")}
          >
            <AiPane s={s} a={a} info={info} layout={layout} area={area} />
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
