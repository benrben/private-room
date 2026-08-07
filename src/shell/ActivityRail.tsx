import type { ReactElement } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FocusIcon,
  GlobeIcon,
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

/** The rail's own label for an area, reused by anything that has to name a
 * place, so two surfaces can never disagree about what somewhere is called. */
export function areaLabel(key: WorkArea): string {
  return AREAS.find((a) => a.key === key)?.label ?? "Files";
}

const AREAS: {
  key: Exclude<WorkArea, "files">;
  label: string;
  /** Short label shown under the icon in the COLLAPSED rail (≤9 chars). */
  short: string;
  icon: (size: number) => ReactElement;
}[] = [
  { key: "home", label: "Room home", short: "Home", icon: (s) => <HomeIcon size={s} /> },
  // Find sits second because it is how you get anywhere in a room you have
  // stopped remembering the shape of.
  { key: "find", label: "Find", short: "Find", icon: (s) => <SearchIcon size={s} /> },
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
  {
    key: "browser",
    label: "Private browser",
    short: "Browser",
    icon: (s) => <GlobeIcon size={s} />,
  },
];

/** The activity rail: the app's ONE primary navigation.
 *
 * It used to share that job with the tab strip — every rail click also opened
 * an "area" tab, so Home / Map / Recordings / Workflows / Scripts / Skills /
 * Memory / Connectors / Browser were listed twice, in two different visual
 * languages, and the strip filled up with places rather than with the
 * documents the user was actually working on. The rail wins that argument for
 * three reasons: it is always visible, it can carry a readable label for every
 * destination, and its order is stable — a tab strip's is not, because it
 * reorders itself as you work. So: the rail navigates to PLACES, the strip
 * holds the DOCUMENTS you have open, and neither draws the other's job. (The
 * strip's side of that split lives in shell/TabStrip.tsx and Workspace.tsx.)
 *
 * Labels are shown by default and in full. Collapsing to the 84px icon strip
 * is still one click away and still persists per room, but a first-time reader
 * should never have to hover a column of glyphs to find out where they lead;
 * that is also why the collapsed labels stay under the icons rather than being
 * replaced by a tooltip, which the rail's own overflow would clip.
 *
 * The ⌘K command launcher deliberately has NO entry here any more: it is a
 * command, not a place, it already owns the widest control in the top bar, and
 * a second magnifier in the rail next to Find would be exactly the duplication
 * this pass removes. ⌘K itself is untouched. */
export default function ActivityRail({
  layout,
  area,
  onArea,
  onSettings,
  approvals = 0,
  running = 0,
}: {
  layout: LayoutApi;
  area: WorkArea;
  onArea: (area: Exclude<WorkArea, "files">) => void;
  onSettings: () => void;
  /** How many things are WAITING ON THE READER — approvals that cannot
   * proceed until someone answers. Drawn as a hand-circled number. */
  approvals?: number;
  /** How many jobs are running BY THEMSELVES. Drawn as a quiet dot: it is
   * news, not a request. */
  running?: number;
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

      {/* The two groups do different jobs — one shows and hides columns, the
          other goes somewhere — and the headings say so out loud in the
          expanded rail. aria-hidden because the <nav>'s own name already tells
          a screen reader this is "Workspace panes and areas" and every button
          below carries its full purpose in its label; a repeated heading would
          only add noise to the tab order's read-out. */}
      <div className="rail-group-label" aria-hidden>
        Panes
      </div>
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
        {/* Two different facts, so two different marks — and they can appear
            together. An approval is WAITING ON YOU, so it gets the count,
            circled by hand, in the pending yellow the token map reserves for
            "needs review". A running job is the software working on its own,
            which is news rather than a request, so it gets the quiet dot in
            the linked blue that Room Home's stamp already uses for the same
            fact. Summing them into one yellow number said "N things need you"
            when N-1 of them did not, and it made the dot branch unreachable:
            the count was the sum, so it was non-zero whenever the dot would
            have been.

            Both stay aria-hidden. The AI pane's Activity tab is where the
            real, readable list lives, and a toggle whose accessible name
            changed under the reader every time a job finished would be worse,
            not better. */}
        {approvals > 0 && (
          <span className="rail-count nb-circled nb-sem-pending" aria-hidden>
            {approvals > 99 ? "99+" : approvals}
          </span>
        )}
        {running > 0 && (
          <span className="rail-badge nb-sem-linked" aria-hidden />
        )}
      </button>

      <div className="rail-group-label" aria-hidden>
        Areas
      </div>
      <div className="rail-divider" aria-hidden />

      {AREAS.map((a) => (
        <RailAreaButton key={a.key} def={a} area={area} onArea={onArea} wide={wide} />
      ))}

      <div className="rail-spacer" />

      <div className="rail-divider" aria-hidden />
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
