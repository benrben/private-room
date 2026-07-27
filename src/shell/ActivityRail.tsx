import type { ReactElement } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
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
  BookOpenIcon,
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
  { key: "skills", label: "Skills", short: "Skills", icon: (s) => <BookOpenIcon size={s} /> },
  {
    key: "memory",
    label: "Memory & scratch pad",
    short: "Memory",
    icon: (s) => <MemoryIcon size={s} />,
  },
  { key: "connectors", label: "Connectors", short: "Connect", icon: (s) => <LinkIcon size={s} /> },
];

/** The activity rail. Two deliberately different groups: pane visibility
 * (neutral pressed state) and product-area navigation (accent current
 * state), plus Focus editor and Settings at the bottom. Every button carries
 * a persistent visible label (`.rail-label`) rather than relying on a hover
 * tooltip — the rail is a scroll container (`overflow-x: hidden`, needed for
 * its vertical auto-scroll), so a popover tooltip anchored to a narrow button
 * gets silently clipped to a couple of characters. The aria-label carries the
 * keyboard shortcut for screen readers instead.
 *
 * GH #2: the rail expands. Collapsed it is a 74px icon strip whose labels have
 * to be abbreviated ("Connect", "Record"); expanded it is a 184px column with
 * the icon and the FULL label side by side. The choice persists per room. */
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
  const wide = layout.railExpanded;
  return (
    <nav
      className={`activity-rail${wide ? " is-expanded" : ""}`}
      aria-label="Workspace panes and areas"
    >
      <button
        className="rail-button rail-expander"
        type="button"
        data-testid="rail-expander"
        aria-expanded={wide}
        aria-label={wide ? "Collapse the sidebar to icons" : "Expand the sidebar to show full labels"}
        onClick={layout.toggleRail}
      >
        {wide ? <ChevronLeftIcon size={17} /> : <ChevronRightIcon size={17} />}
        <span className="rail-label">{wide ? "Collapse" : "Expand"}</span>
      </button>

      <div className="rail-divider" aria-hidden />

      <button
        className="rail-button"
        type="button"
        data-pane-toggle="library"
        aria-pressed={paneVisible("library")}
        aria-label="Toggle the Library pane (⌘1)"
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
        aria-label="Toggle the workspace pane (⌘2)"
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
        aria-label="Toggle the AI and Studio pane (⌘3)"
        onClick={() => layout.togglePane("ai")}
      >
        <PanelRightIcon size={17} />
        <span className="rail-label">AI</span>
        {aiAttention && <span className="rail-badge" aria-hidden />}
      </button>

      <div className="rail-divider" aria-hidden />

      {AREAS.slice(0, 1).map((a) => (
        <RailAreaButton key={a.key} def={a} area={area} onArea={onArea} wide={wide} />
      ))}
      <button
        className="rail-button"
        type="button"
        aria-label="Search this room or run a command (⌘K)"
        onClick={onSearch}
      >
        <SearchIcon size={17} />
        <span className="rail-label">Search</span>
      </button>
      {AREAS.slice(1).map((a) => (
        <RailAreaButton key={a.key} def={a} area={area} onArea={onArea} wide={wide} />
      ))}

      <div className="rail-spacer" />

      <button
        className={`rail-button zen`}
        type="button"
        aria-pressed={layout.focusPane === "center"}
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
        aria-label="Open room settings (⌘,)"
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
  wide,
}: {
  def: (typeof AREAS)[number];
  area: WorkArea;
  onArea: (area: Exclude<WorkArea, "files">) => void;
  /** Expanded rail: room for the real name, so drop the ≤9-char abbreviation
   * ("Connect" → "Connectors"). */
  wide: boolean;
}) {
  const current = area === def.key;
  return (
    <button
      className="rail-button"
      type="button"
      data-area={def.key}
      aria-current={current ? "true" : undefined}
      aria-label={`Open ${def.label}`}
      onClick={() => onArea(def.key)}
    >
      {def.icon(17)}
      <span className="rail-label">{wide ? def.label : def.short}</span>
    </button>
  );
}
