import { ChevronDownIcon, FocusIcon, PanelLeftIcon, PanelRightIcon, CheckIcon } from "../icons";
import { LayoutApi, PRESETS, type PresetName } from "../shell/useLayout";

/** The room's layout, in one menu.
 *
 * This replaces three buttons that sat at the top of the sidebar's list of
 * destinations — Library, Workspace, AI — pretending to be places. They were
 * not places: they showed and hid columns, which is a different kind of act
 * from going somewhere, and putting them in the same column in the same visual
 * language as nine actual destinations is what made that column read as a wall
 * of ten equivalent icons. Apple's own guidance is the same shape: a sidebar
 * lists places, and the controls that arrange the window belong in the
 * toolbar.
 *
 * Three things are true of this menu that were not true of those buttons:
 *
 *   • THE WORKSPACE IS NOT IN IT. It cannot be hidden any more — it is the one
 *     pane the room is always for, and "hide the workspace" left a window with
 *     nothing in it. Focus, below, is what people reaching for that actually
 *     wanted: the sides step away and the workspace takes the width.
 *   • THE KEYS ARE PRINTED. ⌘1 and ⌘2 were only ever learnable from a tooltip
 *     on a button that has now moved. A menu row is where a shortcut is
 *     supposed to be taught.
 *   • THE PRESETS ARE REACHABLE. "Get out of the way so I can read this" was
 *     three separate acts nobody performed, so the layout simply stayed wrong.
 *
 * Narrow windows show one pane at a time, and the rows keep working: asking
 * for the assistant hands it the window, asking again hands it back. The
 * checkmark tracks what is ON SCREEN rather than what is stored, so it stays
 * honest in both modes. */
export default function LayoutMenu({
  layout,
  open,
  onOpenChange,
}: {
  layout: LayoutApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shows = (k: "library" | "ai") => layout.visible.includes(k);
  const focused = layout.focusPane === "center";

  return (
    <div className="layout-menu-wrap">
      <button
        className="pill-btn"
        type="button"
        data-testid="layout-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <PanelLeftIcon size={14} />
        <span>Layout</span>
        <ChevronDownIcon size={11} className="pill-caret" />
      </button>

      {open && (
        <>
          <div className="menu-backdrop" onMouseDown={() => onOpenChange(false)} />
          <div className="pop-menu layout-menu" role="menu">
            <div className="pop-label" aria-hidden>
              Panes
            </div>
            <MenuCheck
              label="Library"
              hint="⌘1"
              icon={<PanelLeftIcon size={14} />}
              checked={shows("library")}
              onClick={() => {
                layout.togglePane("library");
                onOpenChange(false);
              }}
            />
            <MenuCheck
              label="Assistant"
              hint="⌘2"
              icon={<PanelRightIcon size={14} />}
              checked={shows("ai")}
              onClick={() => {
                layout.togglePane("ai");
                onOpenChange(false);
              }}
            />
            <MenuCheck
              label="Focus the workspace"
              hint={focused ? "Esc to leave" : undefined}
              icon={<FocusIcon size={14} />}
              checked={focused}
              onClick={() => {
                layout.toggleFocus("center");
                onOpenChange(false);
              }}
            />

            <div className="pop-sep" role="separator" />
            <div className="pop-label" aria-hidden>
              Presets
            </div>
            {(Object.keys(PRESETS) as PresetName[]).map((name) => (
              <button
                key={name}
                className="pop-item pop-item-preset"
                role="menuitem"
                onClick={() => {
                  layout.applyPreset(name);
                  onOpenChange(false);
                }}
              >
                {/* The spacer keeps every row's text on one left edge, so the
                    checkable rows above and these do not read as two lists. */}
                <span className="pop-tick" aria-hidden />
                <span className="pop-text">
                  <span className="pop-title">{PRESETS[name].label}</span>
                  <span className="pop-hint">{PRESETS[name].hint}</span>
                </span>
              </button>
            ))}

            <div className="pop-sep" role="separator" />
            <button
              className="pop-item"
              role="menuitem"
              onClick={() => {
                layout.resetLayout();
                onOpenChange(false);
              }}
            >
              <span className="pop-tick" aria-hidden />
              <span className="pop-text">Reset layout</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A row whose state is a fact about the window, drawn with a tick.
 *
 * `menuitemcheckbox` rather than `menuitem`, so the state reaches a screen
 * reader as state rather than as a word buried in a label — and the tick is
 * `aria-hidden`, because `aria-checked` already carries it and a reader
 * announcing both would say it twice. */
function MenuCheck({
  label,
  hint,
  icon,
  checked,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: React.ReactNode;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="pop-item"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
    >
      <span className="pop-tick" aria-hidden>
        {checked && <CheckIcon size={13} />}
      </span>
      <span className="pop-glyph" aria-hidden>
        {icon}
      </span>
      <span className="pop-text">{label}</span>
      {hint && <span className="pop-key">{hint}</span>}
    </button>
  );
}
