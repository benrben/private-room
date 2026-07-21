import { useCallback } from "react";
import { Props, WorkArea } from "./workspace/types";
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

  const openArea = useCallback(
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

  const pendingApprovals =
    s.mcpApprovals.length + s.editApprovals.length + s.scriptApprovals.length;
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
      <FeedbackModal s={s} />
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
