/** The theme a sandboxed document frame should render in.
 *
 * A `roomdoc://` frame is a separate, opaque origin: it cannot read the app's
 * `data-theme` attribute or its CSS variables, so its own stylesheet would
 * fall back to `prefers-color-scheme` — the MAC's setting. With the app on
 * light and the Mac on dark, a Word document or an e-book chapter then renders
 * as a dark page inside a light window. The theme has to be handed in.
 */
export function frameIsDark(): boolean {
  if (typeof document === "undefined") return false;
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "light") return false;
  if (stamped === "dark") return true;
  // Nothing stamped yet: fall back to the Mac, which is what the app does too.
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}
