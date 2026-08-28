import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from "../icons";
import { areaDef, useNavPrefs, type NavArea } from "./navPrefs";
import { useFocusTrap } from "../settings/useFocusTrap";

/** Pin, hide and reorder the sidebar's destinations.
 *
 * Rendered in two places and written once: as a sheet over the workspace (the
 * sidebar's own "Customize sidebar" row) and inline inside Settings →
 * Interface. Two copies of a list of eleven toggles is two copies to keep in
 * step, and the one that fell behind would be the one nobody was looking at.
 *
 * ----- why toggles and arrows rather than drag-and-drop -----
 *
 * The mockup this came from draws grab handles. Drag is the right gesture for
 * a long list you are shaping by feel; this is eleven fixed rows in two
 * groups, where the whole job is "is this one at hand, and roughly where".
 * Arrows are operable from the keyboard without a drag-and-drop accessibility
 * story, they cannot half-succeed, and they leave the row's target area to the
 * control that actually matters — the switch.
 *
 * A row moves only WITHIN its own group. Dragging across the boundary would
 * have to silently pin or unpin as a side effect of a reorder, and a gesture
 * that changes two things at once is one nobody can predict. Pinning is the
 * switch's job and stays the switch's job.
 *
 * ----- the library's absence is the point -----
 *
 * There is no Library row and there is a sentence at the bottom saying so.
 * Someone who remembers Library sitting in that column will come looking for
 * it here first, and finding nothing with no explanation reads as the feature
 * having been removed rather than moved. */
export function CustomizeSidebarBody() {
  const nav = useNavPrefs();

  return (
    <div className="cz-body">
      <Group
        label="Pinned"
        hint="Always visible in the sidebar."
        keys={nav.pinned}
        pinned
        nav={nav}
      />
      <Group
        label="Under More tools"
        hint="One click away, and listed in ⌘K whether pinned or not."
        keys={nav.more}
        pinned={false}
        nav={nav}
      />

      <p className="cz-note">
        The second column isn’t here because it isn’t a destination — it’s a
        pane, and each destination fills it with its own list. Show or hide it
        from <b>Layout</b> in the toolbar, or press <kbd>⌘1</kbd>.
      </p>

      <button className="cz-reset" type="button" onClick={nav.reset}>
        Reset the sidebar
      </button>
    </div>
  );
}

function Group({
  label,
  hint,
  keys,
  pinned,
  nav,
}: {
  label: string;
  hint: string;
  keys: NavArea[];
  pinned: boolean;
  nav: ReturnType<typeof useNavPrefs>;
}) {
  return (
    <section className="cz-group">
      <h4 className="cz-group-label">{label}</h4>
      <p className="cz-group-hint">{hint}</p>
      {keys.length === 0 ? (
        <p className="cz-empty">
          {pinned
            ? "Nothing pinned — every tool is under More tools."
            : "Everything is pinned."}
        </p>
      ) : (
        <ul className="cz-list">
          {keys.map((key, i) => {
            const def = areaDef(key);
            return (
              <li className="cz-row" key={key}>
                <span className="cz-glyph" aria-hidden>
                  {def.icon(16)}
                </span>
                <span className="cz-text">
                  <span className="cz-name">{def.label}</span>
                  <span className="cz-blurb">{def.blurb}</span>
                </span>
                <span className="cz-move">
                  <button
                    type="button"
                    className="cz-arrow"
                    aria-label={`Move ${def.label} up`}
                    disabled={i === 0}
                    onClick={() => nav.move(key, -1)}
                  >
                    <ChevronUpIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="cz-arrow"
                    aria-label={`Move ${def.label} down`}
                    disabled={i === keys.length - 1}
                    onClick={() => nav.move(key, 1)}
                  >
                    <ChevronDownIcon size={14} />
                  </button>
                </span>
                {/* `switch`, not a checkbox: the row is not being SELECTED for
                    a later action, it is being turned on and off, and it takes
                    effect the moment it is pressed. */}
                <button
                  type="button"
                  className="cz-switch"
                  role="switch"
                  aria-checked={pinned}
                  aria-label={`Pin ${def.label} to the sidebar`}
                  onClick={() => nav.togglePin(key)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The sheet form, raised from the sidebar's own row. Reuses the settings
 * modal's frame and its focus trap, so it is dismissed exactly like every
 * other sheet in the app — Escape, the backdrop, or Done. */
export default function CustomizeSidebar({ onClose }: { onClose: () => void }) {
  const { modalRef, onModalKeyDown } = useFocusTrap(onClose);
  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="settings cz-modal"
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Customize sidebar"
      >
        <div className="settings-head">
          <span className="badge-label">Customize sidebar</span>
          <button
            className="subtle btn-ic"
            type="button"
            title="Close"
            aria-label="Close the sidebar settings"
            onClick={onClose}
          >
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="settings-body">
          <CustomizeSidebarBody />
        </div>
      </div>
    </div>
  );
}
