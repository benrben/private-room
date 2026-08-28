// BROWSE-1: popup / new-window handling.
//
// Replaces `NO_POPUPS_JS` (src-tauri/src/browser.rs) with Electron's
// first-class `webContents.setWindowOpenHandler()`.
//
// THE BUG NO_POPUPS_JS EXISTED FOR: `target="_blank"` and `window.open()` both
// ask WebKit's UI delegate for a new web view, and wry answers `nil` unless a
// handler is installed — so every such link did nothing at all. Worse, the
// navigation hook could not tell that from a real navigation: it recorded the
// destination as this tab's address for a page the browser had not left, and
// the address bar, the tab strip and `browse_open`'s answer all read off that
// record. The workaround was a page-side script that overrode `window.open` and
// intercepted capture-phase clicks — and its own comment concedes what it could
// not catch ("a form's target, a `<base target>` and a ⌘-click still reach
// WebKit and are still dead"), because a script inside the page can only see
// the two DOM-level triggers.
//
// `setWindowOpenHandler` is the hook wry lacked, and it sits above the DOM: it
// covers `window.open()`, a `target="_blank"` link, a shift/⌘-click, and a form
// submission with `target="_blank"` alike. So this is a strict replacement, not
// a partial one, and NO_POPUPS_JS is not ported alongside it.
//
// Denying alone would reproduce wry's ORIGINAL bug (a dead link), so the
// handler denies AND finishes the job `goTo()` did: the requesting page itself
// moves to the destination. `contents.loadURL` always targets the WebContents'
// main frame, which IS the `window.top.location.href` case NO_POPUPS_JS tried
// first — "open in a new window" from an embedded ad means leave this site, and
// replacing the iframe would leave the reader looking at the ad. There is
// therefore no fallback-to-this-frame branch to port.

import type { WebContents } from "electron";

/** The minimum of `WebContents` this module needs, so the handler's decision is
 *  testable without a live renderer. */
export interface PopupContents {
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "deny" } | { action: "allow" },
  ): void;
  loadURL(url: string): Promise<void>;
}

export function attachPopupHandling(contents: PopupContents | WebContents): void {
  const c = contents as PopupContents;
  c.setWindowOpenHandler((details) => {
    // A BARE `window.open()` — the "open a window, then document.write into it"
    // idiom — carries no destination, and Electron resolves that to
    // `about:blank` (confirmed against a live Electron process, which reported
    // exactly `{url: "about:blank"}` for it). Navigating there would blank the
    // page the user was reading in order to honour a popup we are refusing
    // anyway, so a request with no real destination is denied and nothing else.
    // This is the same case wry's own handler could not be installed for: it
    // unwraps the request's URL before calling out, and a bare `window.open()`
    // has none.
    if (details.url && details.url !== "about:blank") {
      // Fire-and-forget, like the page-script version's assignment to
      // `location.href`. A destination the WebContents refuses (the navigation
      // gate blocked it, say) fails silently here, exactly as a thrown
      // assignment would have.
      void c.loadURL(details.url).catch(() => {});
    }
    // A page that tests for a blocked popup gets the answer it knows.
    return { action: "deny" };
  });
}
