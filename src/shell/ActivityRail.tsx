import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ListFilterIcon,
  SettingsIcon,
  ToolsIcon,
} from "../icons";
import { LayoutApi } from "./useLayout";
import { areaDef, useNavPrefs, type NavArea } from "./navPrefs";
import type { WorkArea } from "../workspace/types";

export type { WorkArea };

/** The sidebar: the app's ONE primary navigation, and now ONLY that.
 *
 * ----- what it used to be -----
 *
 * A column of seventeen buttons in four visual languages. Three PANE TOGGLES
 * at the top (Library / Workspace / AI), then eleven DESTINATIONS in four
 * labelled groups, then Focus and Settings. The toggles and the destinations
 * looked identical and did categorically different things: one pair of them
 * showed and hid columns, the rest went somewhere. A reader arriving at that
 * column could not tell which was which without clicking, and the fastest
 * available reading — "ten icons, all equivalent, all mine to learn" — was
 * the wrong one.
 *
 * ----- what it is now -----
 *
 * Places, in two tiers. A short pinned list the room is actually used from,
 * then everything else behind ONE disclosure that remembers nothing and hides
 * nothing permanently. The pane toggles moved to the toolbar's Layout menu
 * (workspace/LayoutMenu.tsx), which is where a control that arranges the
 * window belongs and where its keyboard shortcut can finally be printed
 * beside it. Focus went with them: it is a mode, not a place.
 *
 * THE LIBRARY IS DELIBERATELY NOT IN THIS LIST. It is a pane — see
 * shell/navPrefs.tsx, which owns the catalog and says so at length.
 *
 * ----- the three things that survived unchanged, on purpose -----
 *
 *   • `data-area` on every destination button. Four capture specs and two QA
 *     specs select on it, and qa/UA-FEATURE-CHECKLIST.md documents it as a
 *     contract. The structure around it changed; the hook did not.
 *   • The `.activity-rail` class, which src/agent/driver.ts maps to the region
 *     name the embodiment loop reports. Renaming it would silently stop the
 *     agent from being able to say where a control is.
 *   • Labels by default, in full. A destination a first-time reader has to
 *     hover to identify is not navigation. The icon-only strip is still
 *     reachable — and is now also applied automatically on a narrow window,
 *     which is the one case where the words genuinely do not fit.
 *
 * ----- what the disclosure costs, and what pays for it -----
 *
 * Six destinations behind a collapsed row are invisible to `uiSnapshot()` in
 * the embodiment loop until it is expanded, which would quietly cost the agent
 * six places it can navigate to. ⌘K is what pays for it: `buildPaletteActions`
 * in workspace/Overlays.tsx lists EVERY area by name whether or not it is
 * pinned, so the palette — not this column — is the complete route. Keep it
 * that way; a destination added here and not there is a destination the agent
 * cannot reach. */
export default function ActivityRail({
  layout,
  area,
  onArea,
  onSettings,
  onCustomize,
}: {
  layout: LayoutApi;
  area: WorkArea;
  onArea: (area: NavArea) => void;
  onSettings: () => void;
  onCustomize: () => void;
}) {
  const nav = useNavPrefs();
  const wide = layout.railExpanded;
  // The disclosure is transient by design — it is not persisted anywhere.
  // "Which tools do I want at hand" is a real preference and lives in
  // `navPrefs`; "is the drawer open right now" is not one, and a drawer that
  // reopened itself every launch would make pinning pointless.
  //
  // WHERE YOU ARE IS ALWAYS ON SCREEN. Arriving at Workflows from ⌘K, a
  // toast's "Scripts" action or a Home row must not leave the sidebar marking
  // nothing as current — the highlight would be drawn on a row that is not
  // rendered, so the column would claim the room is nowhere.
  //
  // The closed disclosure therefore shows exactly ONE row when the current
  // place lives inside it: that place. Forcing the whole group open instead
  // would be simpler and would make the toggle a dead control — pressing
  // "hide these" while standing in one of them would do nothing visible, which
  // is worse than the problem it solves. This way the toggle always works and
  // the sidebar never loses you.
  const current = nav.more.includes(area as NavArea) ? (area as NavArea) : null;
  const moreRows = layout.moreToolsOpen ? nav.more : current ? [current] : [];

  return (
    <nav
      className={`activity-rail${wide ? " is-expanded" : ""}`}
      aria-label="Destinations"
    >
      {/* Hidden entirely while the WINDOW is what collapsed the rail: a
          control that cannot change what you are looking at is worse than no
          control. The preference underneath is untouched and comes back with
          the width. */}
      {!layout.railAutoCollapsed && (
        <button
          className="rail-button rail-expander"
          type="button"
          data-testid="rail-expander"
          aria-expanded={wide}
          aria-label={
            wide
              ? "Collapse the sidebar to icons"
              : "Expand the sidebar to show full labels"
          }
          /* Icon-only when the rail is, like every other row. It used to keep
             a visible word at both widths, which left it as the single
             labelled control in an otherwise wordless column — the one place
             a label was least needed, since a chevron pointing out of the rail
             is the most self-evident glyph in it. */
          title={wide ? undefined : "Expand the sidebar"}
          onClick={layout.toggleRail}
        >
          {wide ? <ChevronLeftIcon size={17} /> : <ChevronRightIcon size={17} />}
          {wide && <span className="rail-label">Collapse</span>}
        </button>
      )}

      <div className="rail-group-label" aria-hidden>
        Core
      </div>
      <div className="rail-divider" aria-hidden />
      {nav.pinned.map((key) => (
        <RailAreaButton key={key} areaKey={key} area={area} onArea={onArea} wide={wide} />
      ))}
      {nav.pinned.length === 0 && wide && (
        <p className="rail-empty">
          Nothing pinned. Everything is under More tools.
        </p>
      )}

      {nav.more.length > 0 && (
        <>
          <div className="rail-group-label" aria-hidden>
            On demand
          </div>
          <div className="rail-divider" aria-hidden />
          <button
            className="rail-button rail-more"
            type="button"
            data-testid="more-tools"
            aria-expanded={layout.moreToolsOpen}
            aria-label={
              layout.moreToolsOpen
                ? `Hide the other ${nav.more.length} tools`
                : `Show ${nav.more.length} more tools`
            }
            title={wide ? undefined : "More tools"}
            onClick={layout.toggleMoreTools}
          >
            <ToolsIcon size={17} />
            {wide && <span className="rail-label">More tools</span>}
            {wide && (
              <ChevronDownIcon
                size={13}
                className={`rail-chev${layout.moreToolsOpen ? " is-open" : ""}`}
              />
            )}
          </button>
          {moreRows.map((key) => (
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
      )}

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
        <ListFilterIcon size={17} />
        {wide && <span className="rail-label">Customize sidebar</span>}
      </button>
      <button
        className="rail-button"
        type="button"
        aria-label="Open room settings (⌘,)"
        title={wide ? undefined : "Settings"}
        onClick={onSettings}
      >
        <SettingsIcon size={17} />
        {wide && <span className="rail-label">Settings</span>}
      </button>
    </nav>
  );
}

function RailAreaButton({
  areaKey,
  area,
  onArea,
  wide,
  nested,
}: {
  areaKey: NavArea;
  area: WorkArea;
  onArea: (area: NavArea) => void;
  /** Expanded rail: room for the full label. Collapsed: icon only, with the
   * same full label carried as a native `title` tooltip — deliberately not
   * the rail's own `[data-tip]` CSS pattern, which is positioned against its
   * own button and would be clipped by the rail's `overflow: hidden auto`,
   * exactly as a label would be. Never a shortened or renamed label: an
   * abbreviation ("Connect") mis-names the destination, and a clipped one is
   * unreadable. */
  wide: boolean;
  /** Under the More tools disclosure — indented, so the two tiers are legible
   * as tiers rather than as one longer list that happens to have a button in
   * the middle of it. */
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
