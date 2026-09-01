import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListFilterIcon,
  SettingsIcon,
  ToolsIcon,
} from "../icons";
import type { WorkArea } from "../workspace/types";
import type { LayoutApi } from "./useLayout";
import { areaDef, useNavPrefs, type NavArea } from "./navPrefs";

export type { WorkArea };

type ActivityRailProps = {
  layout: LayoutApi;
  area: WorkArea;
  onArea: (area: NavArea) => void;
  onSettings: () => void;
  onCustomize: () => void;
};

function currentMoreArea(area: WorkArea, more: NavArea[]) {
  return more.includes(area as NavArea) ? (area as NavArea) : null;
}

function shownMoreRows(open: boolean, more: NavArea[], current: NavArea | null) {
  if (open) return more;
  return current ? [current] : [];
}

function moreToolsLabel(open: boolean, moreCount: number, current: NavArea | null) {
  const hiddenCount = moreCount - (current ? 1 : 0);
  if (hiddenCount === 0) return "More tools";
  const tool = hiddenCount === 1 ? "tool" : "tools";
  return open ? `Hide the other ${hiddenCount} ${tool}` : `Show ${hiddenCount} more ${tool}`;
}

function RailExpander({ layout }: { layout: LayoutApi }) {
  if (layout.railAutoCollapsed) return null;
  const wide = layout.railExpanded;
  const label = wide
    ? "Collapse the sidebar to icons"
    : "Expand the sidebar to show full labels";
  return (
    <button
      className="rail-button rail-expander"
      type="button"
      data-testid="rail-expander"
      aria-expanded={wide}
      aria-label={label}
      title={wide ? undefined : "Expand the sidebar"}
      onClick={layout.toggleRail}
    >
      {wide ? <ChevronLeftIcon size={16} /> : <ChevronRightIcon size={16} />}
      {wide && <span className="rail-label">Collapse</span>}
    </button>
  );
}

function RailAreaButton({
  areaKey,
  area,
  onArea,
  wide,
  nested = false,
}: {
  areaKey: NavArea;
  area: WorkArea;
  onArea: (area: NavArea) => void;
  wide: boolean;
  nested?: boolean;
}) {
  const def = areaDef(areaKey);
  const current = area === areaKey;
  return (
    <button
      className={`rail-button${nested ? " is-nested" : ""}`}
      type="button"
      data-area={areaKey}
      aria-current={current ? "true" : undefined}
      aria-label={`Open ${def.label}`}
      title={wide ? undefined : def.label}
      onClick={() => onArea(areaKey)}
    >
      {def.icon(17)}
      {wide && <span className="rail-label">{def.label}</span>}
    </button>
  );
}

function PinnedAreas({
  pinned,
  area,
  onArea,
  wide,
}: {
  pinned: NavArea[];
  area: WorkArea;
  onArea: (area: NavArea) => void;
  wide: boolean;
}) {
  return (
    <>
      <div className="rail-group-label" aria-hidden>Pinned</div>
      <div className="rail-divider" aria-hidden />
      {pinned.map((key) => (
        <RailAreaButton key={key} areaKey={key} area={area} onArea={onArea} wide={wide} />
      ))}
      {pinned.length === 0 && wide && (
        <p className="rail-empty">Nothing pinned. Everything is under More tools.</p>
      )}
    </>
  );
}

function MoreTools({
  layout,
  more,
  area,
  onArea,
}: {
  layout: LayoutApi;
  more: NavArea[];
  area: WorkArea;
  onArea: (area: NavArea) => void;
}) {
  if (more.length === 0) return null;
  const wide = layout.railExpanded;
  const current = currentMoreArea(area, more);
  const rows = shownMoreRows(layout.moreToolsOpen, more, current);
  const label = moreToolsLabel(layout.moreToolsOpen, more.length, current);
  return (
    <>
      <div className="rail-divider" aria-hidden />
      <button
        className="rail-button rail-more"
        type="button"
        data-testid="more-tools"
        aria-expanded={layout.moreToolsOpen}
        aria-label={label}
        title={wide ? undefined : "More tools"}
        onClick={layout.toggleMoreTools}
      >
        <ToolsIcon size={16} />
        {wide && <span className="rail-label">More tools</span>}
        {wide && (
          <ChevronDownIcon
            size={14}
            className={`rail-chev${layout.moreToolsOpen ? " is-open" : ""}`}
          />
        )}
      </button>
      {rows.map((key) => (
        <RailAreaButton
          key={key}
          areaKey={key}
          area={area}
          onArea={onArea}
          wide={wide}
          nested
        />
      ))}
    </>
  );
}

function RailFooter({
  wide,
  onSettings,
  onCustomize,
}: {
  wide: boolean;
  onSettings: () => void;
  onCustomize: () => void;
}) {
  return (
    <>
      <div className="rail-spacer" />
      <div className="rail-divider" aria-hidden />
      <button
        className="rail-button"
        type="button"
        data-testid="customize-sidebar"
        aria-label="Customize the sidebar — pin, hide, and reorder tools"
        title={wide ? undefined : "Customize sidebar"}
        onClick={onCustomize}
      >
        <ListFilterIcon size={16} />
        {wide && <span className="rail-label">Customize sidebar</span>}
      </button>
      <button
        className="rail-button"
        type="button"
        aria-label="Open room settings (⌘,)"
        title={wide ? undefined : "Settings"}
        onClick={onSettings}
      >
        <SettingsIcon size={16} />
        {wide && <span className="rail-label">Settings</span>}
      </button>
    </>
  );
}

/** The workspace's single primary destination rail. */
export default function ActivityRail({
  layout,
  area,
  onArea,
  onSettings,
  onCustomize,
}: ActivityRailProps) {
  const nav = useNavPrefs();
  const wide = layout.railExpanded;
  return (
    <nav
      className={`activity-rail${wide ? " is-expanded" : ""}`}
      aria-label="Destinations"
    >
      <RailExpander layout={layout} />
      <PinnedAreas pinned={nav.pinned} area={area} onArea={onArea} wide={wide} />
      <MoreTools layout={layout} more={nav.more} area={area} onArea={onArea} />
      <RailFooter wide={wide} onSettings={onSettings} onCustomize={onCustomize} />
    </nav>
  );
}
