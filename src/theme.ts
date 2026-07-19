/** App-wide theme: dark (default) or light, stamped as `data-theme` on
 * <html> so tokens.css swaps the palette everywhere — gate, workspace,
 * modals. Persisted globally (not per room): a theme is a device preference. */

export type Theme = "dark" | "light";

const KEY = "prTheme";

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
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
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* preference just won't persist */
  }
  applyTheme(next);
  return next;
}
