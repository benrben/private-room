import { CustomizeSidebarBody } from "../shell/CustomizeSidebar";
import { PRESETS, type PresetName } from "../shell/useLayout";
import {
  useInterfaceSettings,
  type Density,
  type Texture,
} from "./useInterfaceSettings";

const DENSITIES: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const TEXTURES: { value: Texture; label: string }[] = [
  { value: "subtle", label: "Subtle" },
  { value: "off", label: "Off" },
];

/** Settings → App → Interface: how the shell itself is arranged.
 *
 * Everything here is a DEVICE preference, sitting beside Appearance's theme
 * for the same reason — it describes this Mac and this reader, not the
 * contents of any one room. Nothing on this page has a Save; a layout you have
 * to confirm is a layout you cannot preview.
 *
 * The sidebar list is the very same component the "Customize sidebar" sheet
 * renders. Two copies of eleven toggles is two copies to keep in step, and the
 * one that fell behind would be the one nobody was looking at. */
export default function InterfaceSection({
  onApplyPreset,
}: {
  /** Apply a preset to the room behind this modal, when there is one. Absent
   * on any surface that has no live workspace — the buttons then explain
   * themselves rather than pretending to work. */
  onApplyPreset?: (name: PresetName) => void;
}) {
  const ui = useInterfaceSettings();

  return (
    <section id="set-interface">
      <h3>Interface</h3>
      <p className="settings-hint">
        How the window is arranged. These apply to every room on this Mac, not
        just this one, and take effect as you change them.
      </p>

      <label className="settings-label">Sidebar</label>
      <p className="settings-hint">
        Choose which destinations are visible and in what order. Everything
        stays reachable from ⌘K whether it is pinned or not.
      </p>
      <CustomizeSidebarBody />

      <label className="settings-label">Layout presets</label>
      <p className="settings-hint">
        {onApplyPreset
          ? "Apply one to this room now. The same three are in the Layout menu in the toolbar."
          : "Available from the Layout menu in the toolbar once a room is open."}
      </p>
      <div className="iface-presets">
        {(Object.keys(PRESETS) as PresetName[]).map((name) => (
          <button
            key={name}
            type="button"
            className="iface-preset"
            disabled={!onApplyPreset}
            onClick={() => onApplyPreset?.(name)}
          >
            <span className="iface-preset-name">{PRESETS[name].label}</span>
            <span className="iface-preset-hint">{PRESETS[name].hint}</span>
          </button>
        ))}
      </div>

      <label className="settings-label">Density</label>
      <div className="style-seg" role="radiogroup" aria-label="Density">
        {DENSITIES.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={ui.density === o.value}
            className={`style-seg-opt${ui.density === o.value ? " active" : ""}`}
            onClick={() => ui.setDensity(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {/* Said plainly rather than discovered. Compact tightens the spacing and
          type scales the whole interface is built on, which covers most of the
          app well and a few dense pages only roughly. Promising more than that
          would make the rough spots read as bugs rather than as the known
          edge of a setting. */}
      <p className="settings-hint">
        Compact tightens spacing and type across the app. The densest pages —
        Settings, Connectors, Workflows — are tuned for Comfortable and give
        back less room than the rest.
      </p>

      <label className="settings-label">Canvas texture</label>
      <div className="style-seg" role="radiogroup" aria-label="Canvas texture">
        {TEXTURES.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={ui.texture === o.value}
            className={`style-seg-opt${ui.texture === o.value ? " active" : ""}`}
            onClick={() => ui.setTexture(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="settings-hint">
        The dotted paper the room is drawn on. Turning it off leaves the
        surfaces and the ink exactly as they are.
      </p>

      <label className="settings-label">Reset</label>
      <p className="settings-hint">
        Puts the sidebar, the density, the texture and every room’s saved pane
        layout back to how Arcelle ships. It changes nothing inside your rooms
        — no file, note, chat or setting in a room is touched.
      </p>
      {/* NOT `button.danger`. The red outline in this app means "this destroys
          something", and reset destroys no content whatsoever — it puts four
          view preferences back. Dressing it as destructive would teach the red
          to mean "significant", which is what makes it stop meaning anything
          at the one place it has to. */}
      <button className="cz-reset" type="button" onClick={ui.resetAll}>
        Reset to Arcelle defaults
      </button>
    </section>
  );
}
