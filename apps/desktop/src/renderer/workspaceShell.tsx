import type { Props, WorkArea } from "./workspace/types";
import { areaHoldsFile } from "./workspace/types";
import { useTabs, tabId, type Tab } from "./workspace/tabs";
import { useBrowserPages } from "./workspace/browserPages";
import { showsDocumentTabs, sidebarRegionLabel, type NewItemKind } from "./workspace/destinations";
import TabStrip, { type TabTitleFacts } from "./shell/TabStrip";
import { fileLabel } from "./workspace/composer";
import { api, type ViewerKind } from "./api";
import { useWorkspaceState } from "./workspace/state";
import type { WSActions } from "./workspace/actions";
import Overlays from "./workspace/Overlays";
import StudioModal from "./workspace/StudioModal";
import CompareModal from "./workspace/CompareModal";
import UnsavedEditsDialog from "./workspace/UnsavedEditsDialog";
import AiActionModal from "./workspace/AiActionModal";
import FeedbackModal from "./workspace/FeedbackModal";
import SettingsModals from "./workspace/SettingsModals";
import LibraryPane from "./workspace/Sidebar";
import ViewerPane from "./workspace/ViewerPane";
import AiPane from "./workspace/AiPane";
import Toasts from "./workspace/Toasts";
import { useLayout } from "./shell/useLayout";
import ActivityRail from "./shell/ActivityRail";
import CustomizeSidebar from "./shell/CustomizeSidebar";
import Splitter from "./shell/Splitter";
import ErrorBoundary from "./shell/ErrorBoundary";

/** Which place the room was left in, so it reopens there. Sits beside
 * "workspace_tabs" (see workspace/tabs.ts) — same room, same lifetime, and
 * the two are read back together on the way in. */
export const AREA_SETTING = "workspace_area";

/** Pages whose whole job is reading or capturing, where the AI column steps
 * aside on arrival so the document gets the width (see useLayout's
 * `setFocusedPage`). Long-form documents and recordings only: a spreadsheet, a
 * script or a note is something you work ON, usually with the assistant, and
 * closing its column would be taking a tool away mid-task. */
export const FOCUSED_KINDS = new Set<ViewerKind>([
  "book",
  "pdf",
  "prose",
  "email",
  "worddoc",
  "docx",
  "slides",
  "subtitle",
  "recording",
  "audio",
  "video",
]);

type WorkspaceTabKeyboardTabs = Pick<
  ReturnType<typeof useTabs>,
  "activateIndex" | "step"
>;
type WorkspaceState = ReturnType<typeof useWorkspaceState>;
type WorkspaceLayout = ReturnType<typeof useLayout>;
type WorkspacePages = ReturnType<typeof useBrowserPages>;
type WorkspaceTabs = ReturnType<typeof useTabs>;

interface WorkspaceTabKeyboardOptions {
  area: WorkArea;
  files: ReadonlyArray<{ id: string }>;
  guardLeave: WSActions["guardLeave"];
  reopenableRef: { current: string[] };
  tabs: WorkspaceTabKeyboardTabs;
  viewFile: WSActions["viewFile"];
}

function hasWorkspaceCommandModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function handleAltDigitTabKey(event: KeyboardEvent, options: WorkspaceTabKeyboardOptions): boolean {
  if (!event.altKey) return false;
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (digit === null || !showsDocumentTabs(options.area)) return true;
  event.preventDefault();
  options.guardLeave("Switching tabs", () => options.tabs.activateIndex(Number(digit[1]) - 1));
  return true;
}

function shiftedBracketStep(event: KeyboardEvent): number | null {
  if (!event.shiftKey) return null;
  return { "]": 1, "}": 1, "[": -1, "{": -1 }[event.key] ?? null;
}

function handleBracketTabKey(event: KeyboardEvent, options: WorkspaceTabKeyboardOptions): boolean {
  const step = shiftedBracketStep(event);
  if (step === null) return false;
  if (!showsDocumentTabs(options.area)) return true;
  event.preventDefault();
  options.guardLeave("Switching tabs", () => options.tabs.step(step));
  return true;
}

function nextReopenableFile(
  files: ReadonlyArray<{ id: string }>,
  reopenableRef: { current: string[] },
): string | undefined {
  const live = new Set(files.map((file) => file.id));
  let id = reopenableRef.current.pop();
  while (id && !live.has(id)) id = reopenableRef.current.pop();
  return id;
}

function reopenClosedTab(event: KeyboardEvent, options: WorkspaceTabKeyboardOptions): void {
  if (event.key.toLowerCase() !== "t" || !event.shiftKey) return;
  event.preventDefault();
  const id = nextReopenableFile(options.files, options.reopenableRef);
  if (id) void options.viewFile(id);
}

export function handleWorkspaceTabKeydown(event: KeyboardEvent, options: WorkspaceTabKeyboardOptions): void {
  if (!hasWorkspaceCommandModifier(event)) return;
  if (handleAltDigitTabKey(event, options)) return;
  if (handleBracketTabKey(event, options)) return;
  reopenClosedTab(event, options);
}

export function workspaceArea(s: WorkspaceState): WorkArea {
  if (s.showWorkflows) return "workflows";
  if (s.showScripts) return "scripts";
  if (s.showMap) return "map";
  return s.area;
}

export function rememberedFileForArea(area: WorkArea, s: WorkspaceState): string {
  const leaving = s.openFileRef.current?.id ?? "";
  if (!leaving) return "";
  return areaHoldsFile(area, leaving, s.files, s.scripts) ? leaving : "";
}

export function restoreRememberedFile(
  area: WorkArea,
  lastFileRef: { current: Partial<Record<WorkArea, string>> },
  files: WorkspaceState["files"],
  viewFile: WSActions["viewFile"],
): void {
  const wanted = lastFileRef.current[area] ?? "";
  if (!wanted || !files.some((file) => file.id === wanted)) return;
  void viewFile(wanted);
}

interface FileTabSyncOptions {
  files: WorkspaceState["files"];
  openFileId: string;
  tabbedFileRef: { current: string };
  tabs: Pick<WorkspaceTabs, "open" | "retitle">;
}

export function syncOpenFileTab({ files, openFileId, tabbedFileRef, tabs }: FileTabSyncOptions): void {
  if (!openFileId) {
    tabbedFileRef.current = "";
    return;
  }
  const meta = files.find((file) => file.id === openFileId);
  if (meta?.libraryVisibility === "sectionOnly") {
    tabbedFileRef.current = "";
    return;
  }
  const title = fileLabel(meta?.name ?? "File", files);
  if (tabbedFileRef.current === openFileId) {
    tabs.retitle(tabId("file", openFileId), title);
    return;
  }
  tabbedFileRef.current = openFileId;
  tabs.open("file", openFileId, title);
}

function paneClass(name: string, visible: readonly string[]): string {
  return `pane ${name}${visible.includes(name.replace("pane-", "")) ? "" : " is-hidden"}`;
}

function registerWorkspaceCopy(
  setRegisteringCopy: (value: boolean) => void,
  onRenamed: Props["onRenamed"],
  pushToast: WorkspaceState["pushToast"],
): void {
  setRegisteringCopy(true);
  void api.registerWorkspaceCopy()
    .then((next) => onRenamed?.(next))
    .catch((error) => pushToast("error", error instanceof Error ? error.message : String(error)))
    .finally(() => setRegisteringCopy(false));
}

interface WorkspaceReadOnlyBannerProps {
  info: Props["info"];
  onRenamed: Props["onRenamed"];
  pushToast: WorkspaceState["pushToast"];
  registeringCopy: boolean;
  setRegisteringCopy: (value: boolean) => void;
}

export function WorkspaceReadOnlyBanner({
  info,
  onRenamed,
  pushToast,
  registeringCopy,
  setRegisteringCopy,
}: WorkspaceReadOnlyBannerProps) {
  if (!info.readOnly) return null;
  const duplicateCopy = info.duplicateRoomIdentity;
  return (
    <div className="workspace-readonly-banner" role="status">
      <strong>Read-only room.</strong>{" "}
      {duplicateCopy
        ? "This folder is a raw copy with the same room identity as another workspace. Register it as a new copy before editing."
        : "Another Arcelle process owns the writer lease. You can read the normal files here, but Arcelle will not save edits, run agents, index changes, or change private room data."}
      {duplicateCopy && (
        <button
          type="button"
          disabled={registeringCopy}
          onClick={() => registerWorkspaceCopy(setRegisteringCopy, onRenamed, pushToast)}
        >
          {registeringCopy ? "Registering…" : "Register as new copy"}
        </button>
      )}
    </div>
  );
}

interface WorkspaceModalsProps {
  a: WSActions;
  info: Props["info"];
  layout: WorkspaceLayout;
  s: WorkspaceState;
  showCustomize: boolean;
  setShowCustomize: (value: boolean) => void;
}

export function WorkspaceModals({
  a,
  info,
  layout,
  s,
  showCustomize,
  setShowCustomize,
}: WorkspaceModalsProps) {
  return (
    <>
      <Overlays s={s} a={a} layout={layout} />
      <Toasts toasts={s.toasts} dismissToast={s.dismissToast} />
      <StudioModal s={s} a={a} />
      <UnsavedEditsDialog s={s} />
      <CompareModal s={s} a={a} />
      <AiActionModal s={s} a={a} />
      {s.showFeedback && <FeedbackModal s={s} />}
      <ErrorBoundary scope="Settings">
        <SettingsModals s={s} a={a} info={info} layout={layout} />
      </ErrorBoundary>
      {showCustomize && (
        <ErrorBoundary scope="The sidebar settings">
          <CustomizeSidebar onClose={() => setShowCustomize(false)} />
        </ErrorBoundary>
      )}
    </>
  );
}

interface WorkspacePanesProps {
  a: WSActions;
  activateTab: (id: string) => void;
  area: WorkArea;
  closeTab: (id: string) => void;
  info: Props["info"];
  layout: WorkspaceLayout;
  newItem: (kind: NewItemKind) => void;
  openArea: (area: WorkArea) => void;
  pages: WorkspacePages;
  s: WorkspaceState;
  showCustomize: () => void;
  tabIcon: (tab: Tab) => null;
  tabTitleFacts: (tab: Tab) => TabTitleFacts | null;
  tabs: WorkspaceTabs;
}

export function WorkspacePanes({
  a,
  activateTab,
  area,
  closeTab,
  info,
  layout,
  newItem,
  openArea,
  pages,
  s,
  showCustomize,
  tabIcon,
  tabTitleFacts,
  tabs,
}: WorkspacePanesProps) {
  return (
    <main className="pr-main">
      <ActivityRail
        layout={layout}
        area={area}
        onArea={openArea}
        onSettings={() => s.setShowSettings(true)}
        onCustomize={showCustomize}
      />
      <div
        className={`pane-grid${layout.dragging ? " is-dragging" : ""}`}
        ref={layout.gridRef}
        style={layout.gridStyle}
      >
        <section
          className={paneClass("pane-library", layout.visible)}
          aria-label={sidebarRegionLabel(area)}
          aria-hidden={!layout.visible.includes("library")}
        >
          <ErrorBoundary scope="The sidebar">
            <LibraryPane key={area} s={s} a={a} layout={layout} area={area} pages={pages} onNewItem={newItem} />
          </ErrorBoundary>
        </section>
        <Splitter side="a" layout={layout} label="Resize the sidebar" />
        <section
          className={paneClass("pane-center", layout.visible)}
          aria-label="Workspace"
          aria-hidden={!layout.visible.includes("center")}
        >
          {showsDocumentTabs(area) && (
            <TabStrip
              tabs={{ ...tabs, activate: activateTab, close: closeTab }}
              icons={tabIcon}
              roomId={info.path}
              titleFacts={tabTitleFacts}
            />
          )}
          <ErrorBoundary scope="The workspace pane">
            <ViewerPane s={s} a={a} info={info} layout={layout} area={area} />
          </ErrorBoundary>
        </section>
        <Splitter side="b" layout={layout} label="Resize the AI pane" />
        <section
          className={paneClass("pane-ai", layout.visible)}
          aria-label="AI chat, Studio, and activity"
          aria-hidden={!layout.visible.includes("ai")}
        >
          <ErrorBoundary scope="The AI pane">
            <AiPane s={s} a={a} info={info} layout={layout} area={area} />
          </ErrorBoundary>
        </section>
      </div>
    </main>
  );
}
