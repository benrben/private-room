/** App-wide theme: dark or light, stamped as `data-theme` on <html> so
 * tokens.css swaps the palette everywhere — gate, workspace, modals.
 * Persisted globally (not per room): a theme is a device preference.
 *
 * With no stored preference the app FOLLOWS macOS ("system"), and keeps
 * following it while the Mac's own setting changes. Flipping the switch
 * stores an explicit dark/light that wins from then on. */

export type Theme = "dark" | "light";
/** What is stored: an explicit theme, or "follow the Mac". */
export type ThemeChoice = Theme | "system";

const KEY = "prTheme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The Mac's own setting. Defaults to dark where matchMedia is unavailable. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

/** The stored preference, "system" when the user has never chosen. */
export function getThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
}

/** The theme actually on screen, with "system" resolved. */
export function getTheme(): Theme {
  const choice = getThemeChoice();
  return choice === "system" ? systemTheme() : choice;
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // Keep the anti-flash <html>/<body> inline backgrounds in step, so a
  // reload in light mode doesn't open on a dark frame (and vice versa).
  const bg = theme === "light" ? "#efedf1" : "#121116";
  document.documentElement.style.background = bg;
  document.body.style.background = bg;
}

export function initTheme() {
  applyTheme(getTheme());
  // While the preference is "system", track the Mac live — a user switching
  // macOS to Light at dusk shouldn't have to restart the app.
  try {
    window.matchMedia(DARK_QUERY).addEventListener("change", () => {
      if (getThemeChoice() === "system") applyTheme(systemTheme());
    });
  } catch {
    /* no matchMedia — the theme just won't follow the system live */
  }
}

/** Store an explicit choice (or "system" to go back to following the Mac). */
export function setTheme(choice: ThemeChoice): Theme {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* preference just won't persist */
  }
  const theme = choice === "system" ? systemTheme() : choice;
  applyTheme(theme);
  return theme;
}

/** Flip the theme — and go back to FOLLOWING the Mac whenever the flip lands
 * on what macOS is set to itself.
 *
 * The switch the user has is two-way, so without that last part one press
 * pinned the app off the system setting for good: `setTheme("system")` had no
 * caller anywhere, and the live listener in `initTheme` could never fire again
 * for that user. Pinning "light" while macOS is already light differs from
 * following it only in what happens when macOS changes later — and following
 * is what the user last asked for, so the press stays honest either way. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  return setTheme(next === systemTheme() ? "system" : next);
}
