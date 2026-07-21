import type { ReactElement } from "react";
import {
  FocusIcon,
  GraphIcon,
  HomeIcon,
  LinkIcon,
  MemoryIcon,
  MicIcon,
  PanelCenterIcon,
  PanelLeftIcon,
  PanelRightIcon,
  ScriptIcon,
  SearchIcon,
  SettingsIcon,
  WorkflowsIcon,
} from "../icons";
import { LayoutApi } from "./useLayout";
import type { WorkArea } from "../workspace/types";

export type { WorkArea };

const AREAS: {
  key: Exclude<WorkArea, "files">;
  label: string;
  /** Short label shown under the icon in the rail (≤9 chars). */
  short: string;
  icon: (size: number) => ReactElement;
}[] = [
  { key: "home", label: "Room home", short: "Home", icon: (s) => <HomeIcon size={s} /> },
  { key: "map", label: "Room Map", short: "Map", icon: (s) => <GraphIcon size={s} /> },
  { key: "recordings", label: "Recordings", short: "Record", icon: (s) => <MicIcon size={s} /> },
  {
    key: "workflows",
    label: "Workflows",
    short: "Workflows",
    icon: (s) => <WorkflowsIcon size={s} />,
  },
  { key: "scripts", label: "Scripts", short: "Scripts", icon: (s) => <ScriptIcon size={s} /> },
  {
    key: "memory",
    label: "Memory & scratch pad",
    short: "Memory",
    icon: (s) => <MemoryIcon size={s} />,
  },
  { key: "connectors", label: "Connectors", short: "Connect", icon: (s) => <LinkIcon size={s} /> },
];

/** The 46px activity rail. Two deliberately different groups: pane
 * visibility (neutral pressed state) and product-area navigation (accent
 * current state), plus Focus editor and Settings at the bottom. */
export default function ActivityRail({
  layout,
  area,
  onArea,
  onSearch,
  onSettings,
  aiAttention,
}: {
  layout: LayoutApi;
  area: WorkArea;
  onArea: (area: Exclude<WorkArea, "files">) => void;
  onSearch: () => void;
  onSettings: () => void;
  /** True when background work or an approval wants the AI pane's Activity
   * tab — shows a small amber dot on the pane toggle. */
  aiAttention: boolean;
}) {
  const paneVisible = (k: "library" | "center" | "ai") =>
    layout.visible.includes(k);
  return (
    <nav className="activity-rail" aria-label="Workspace panes and areas">
      <button
        className="rail-button"
        type="button"
        data-pane-toggle="library"
        aria-pressed={paneVisible("library")}
        data-tip="Library (⌘1)"
        aria-label="Toggle the Library pane"
        onClick={() => layout.togglePane("library")}
      >
        <PanelLeftIcon size={17} />
        <span className="rail-label">Library</span>
      </button>
      <button
        className="rail-button"
        type="button"
        data-pane-toggle="center"
        aria-pressed={paneVisible("center")}
        data-tip="Workspace (⌘2)"
        aria-label="Toggle the workspace pane"
        onClick={() => layout.togglePane("center")}
      >
        <PanelCenterIcon size={17} />
        <span className="rail-label">Workspace</span>
      </button>
      <button
        className="rail-button"
        type="button"
        data-pane-toggle="ai"
        aria-pressed={paneVisible("ai")}
        data-tip="AI & Studio (⌘3)"
        aria-label="Toggle the AI and Studio pane"
        onClick={() => layout.togglePane("ai")}
      >
        <PanelRightIcon size={17} />
        <span className="rail-label">AI</span>
        {aiAttention && <span className="rail-badge" aria-hidden />}
      </button>

      <div className="rail-divider" aria-hidden />

      {AREAS.slice(0, 1).map((a) => (
        <RailAreaButton key={a.key} def={a} area={area} onArea={onArea} />
      ))}
      <button
        className="rail-button"
        type="button"
        data-tip="Search room (⌘K)"
        aria-label="Search this room or run a command"
        onClick={onSearch}
      >
        <SearchIcon size={17} />
        <span className="rail-label">Search</span>
      </button>
      {AREAS.slice(1).map((a) => (
        <RailAreaButton key={a.key} def={a} area={area} onArea={onArea} />
      ))}

      <div className="rail-spacer" />

      <button
        className={`rail-button zen`}
        type="button"
        aria-pressed={layout.focusPane === "center"}
        data-tip="Focus the editor"
        aria-label="Focus the editor — hide both side panes"
        onClick={() => layout.toggleFocus("center")}
      >
        <FocusIcon size={17} />
        <span className="rail-label">
          {layout.focusPane === "center" ? "Unfocus" : "Focus"}
        </span>
      </button>
      <button
        className="rail-button"
        type="button"
        data-tip="Room settings (⌘,)"
        aria-label="Open room settings"
        onClick={onSettings}
      >
        <SettingsIcon size={17} />
        <span className="rail-label">Settings</span>
      </button>
    </nav>
  );
}

function RailAreaButton({
  def,
  area,
  onArea,
}: {
  def: (typeof AREAS)[number];
  area: WorkArea;
  onArea: (area: Exclude<WorkArea, "files">) => void;
}) {
  const current = area === def.key;
  return (
    <button
      className="rail-button"
      type="button"
      data-area={def.key}
      aria-current={current ? "true" : undefined}
      data-tip={def.label}
      aria-label={`Open ${def.label}`}
      onClick={() => onArea(def.key)}
    >
      {def.icon(17)}
      <span className="rail-label">{def.short}</span>
    </button>
  );
}
