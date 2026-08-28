import { useState } from "react";
import { getThemeChoice, setTheme, systemTheme, ThemeChoice } from "../theme";

/** Light / dark / follow-the-Mac, where someone would actually look for it.
 *
 * The theme could only be changed from an unlabelled icon in the top bar or by
 * typing "Switch theme" into the command palette, and Settings → App held
 * nothing but the version number — so the honest conclusion from looking in the
 * obvious place was that this app has no light mode. It does.
 *
 * Three options, not the top bar's two-way flip: "Follow the Mac" is a real,
 * reachable state in `theme.ts` (no stored preference, and `initTheme`'s live
 * listener keeps tracking macOS), and the flip can only land on it by accident.
 * Applies instantly — there is no Save on this page, and a theme you have to
 * confirm is a theme you cannot preview. */
const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Follow the Mac" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function AppearanceSection() {
  // Read once from the same store `initTheme` read at startup, so this shows
  // what is actually in force rather than a fresh-install default.
  const [choice, setChoice] = useState<ThemeChoice>(() => getThemeChoice());

  function pick(next: ThemeChoice) {
    setTheme(next);
    setChoice(next);
  }

  return (
    <section id="set-appearance">
      <h3>Appearance</h3>
      <label className="settings-label">Theme</label>
      <div className="style-seg" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={choice === o.value}
            className={`style-seg-opt${choice === o.value ? " active" : ""}`}
            onClick={() => pick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="settings-hint">
        {choice === "system"
          ? `Following macOS, which is currently ${systemTheme()}. Changing it there changes this app straight away.`
          : "A device preference — it applies to every room on this Mac, not just this one."}
      </p>
    </section>
  );
}
