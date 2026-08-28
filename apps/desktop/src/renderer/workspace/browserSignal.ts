/* WHAT THE REST OF THE APP MAY ASSUME ABOUT THE PRIVATE BROWSER'S PAGE.
 *
 * One publisher — `BrowserView`, which is the only component that knows all of
 * it — and any number of readers. It exists because the assistant's scope strip
 * needs to answer "is there a page here, and can its text actually be read
 * right now", and the two ways of getting that answer without this module are
 * both wrong:
 *
 *   • Poll `browser_info` a second time. That was the first shape, and it costs
 *     a real `evaluateJavaScript` round trip into the native page on every beat
 *     — doubled, against the same webview the chrome is already polling — and
 *     it still cannot see `searchOpen` or the reading view, which live in
 *     React state and are exactly what decide whether the page is readable.
 *   • Thread the state down through the shell. `BrowserView` and `AiPane` are
 *     in different panes with no common owner below `Workspace`, and the props
 *     would cross four components that have no interest in any of it.
 *
 * THE READABLE FLAG IS THE WHOLE POINT. A page can be open and on screen and
 * still be unreadable, because the app has parked the native view at 1×1 to
 * show something else in its place — the results list, the start screen, or the
 * reading view itself. Rust refuses to extract text from a parked page rather
 * than return the fragment a one-pixel layout viewport produces, so a scope
 * that offers "this page" in that state promises text nobody can deliver. The
 * publisher already computes parking for its own bounds; this hands the same
 * answer to everyone else instead of letting each reader guess.
 */

export interface BrowserPageSignal {
  url: string;
  title: string;
  /** The page's text can be extracted right now. False while the native view
   *  is parked behind the results list, the start screen or the reading view. */
  readable: boolean;
  /** A passage is selected on the page. Reported by the poll the chrome is
   *  already running, so offering a "selected passage" scope costs nothing —
   *  and a scope offered for a selection that does not exist could only ever
   *  refuse. */
  hasSelection: boolean;
}

/** `null` when the Browser destination is not showing, or has no page. */
let current: BrowserPageSignal | null = null;
const listeners = new Set<() => void>();

function same(a: BrowserPageSignal | null, b: BrowserPageSignal | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.readable === b.readable &&
    a.hasSelection === b.hasSelection
  );
}

/** Publish. A no-op when nothing changed — `useSyncExternalStore` compares
 *  snapshots by identity, so re-publishing an equal object on every 1.2s poll
 *  would re-render every subscriber forever. */
export function publishBrowserPage(next: BrowserPageSignal | null): void {
  if (same(current, next)) return;
  current = next;
  listeners.forEach((fire) => fire());
}

export function browserPageSnapshot(): BrowserPageSignal | null {
  return current;
}

export function subscribeBrowserPage(fire: () => void): () => void {
  listeners.add(fire);
  return () => {
    listeners.delete(fire);
  };
}
