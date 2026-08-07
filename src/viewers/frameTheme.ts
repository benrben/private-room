import { useEffect, useState } from "react";

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

/** Stamp the app's theme onto a self-contained HTML document before staging.
 *
 * Generated documents, studio exports and saved pages all draw from the Rust
 * side's DOC_STYLE, which keys its dark palette off `html[data-theme="dark"]`
 * — the same contract the app uses. Because a `roomdoc://` frame is an opaque
 * origin it cannot read that attribute from the parent, so it has to be
 * written into the markup on the way in. Without this the document falls back
 * to its light palette and a dark-mode room opens a glaring white page.
 *
 * Only ever ADDS the attribute: a document that already declares one (a page
 * the user saved from the web, say) keeps whatever it chose for itself.
 */
export function withFrameTheme(html: string): string {
  const dark = frameIsDark();
  if (!dark) return html;
  // Already themed by its author — leave it alone.
  if (/<html[^>]*\sdata-theme\s*=/i.test(html)) return html;
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html\b/i, '<html data-theme="dark"');
  }
  // A bare fragment with no <html> element: the browser will synthesise one,
  // so prepend a tiny stamp rather than rewriting the markup.
  return `<script>document.documentElement.dataset.theme="dark"</script>${html}`;
}

/** The app's current theme, re-read whenever it changes.
 *
 * `withFrameTheme` bakes the theme into the markup at STAGE time, which means
 * a frame staged in a dark room keeps its dark palette forever — flipping the
 * app to light left a saved page or an e-book chapter charcoal inside an ivory
 * window until the file was closed and reopened. Frames need to re-stage, so
 * they need the theme as a reactive value rather than as a one-shot read.
 *
 * A MutationObserver on the attribute, not a media query: the app themes off
 * `data-theme`, and a media query would track the Mac instead — the very bug
 * this module exists to fix. (Waveform.tsx watches the same attribute for the
 * same reason; wavesurfer also takes its colours as resolved values once.)
 *
 * Put the returned value in a staging effect's dependency array. */
export function useFrameTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    frameIsDark() ? "dark" : "light",
  );
  useEffect(() => {
    const read = () => setTheme(frameIsDark() ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);
  return theme;
}
