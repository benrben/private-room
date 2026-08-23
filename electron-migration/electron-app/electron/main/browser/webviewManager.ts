// BROWSE-1: one page's real, live pieces.
//
// Port of the webview-lifecycle half of `create` in src-tauri/src/browser.rs,
// plus `verify_one_ephemeral` and the `eval_json` transport's real end.
//
// WHY THIS FILE HAS NO TESTS OF ITS OWN, SAID PLAINLY: it is Electron API glue —
// real `WebContentsView`/`session`/`webContents` calls. This workspace's vitest
// runs under plain Node, where `import "electron"` resolves to the binary's
// PATH rather than the API object (keychain.ts's own doc comment records the
// same thing). Every DECISION this file would otherwise make has been moved
// into a pure, tested module (tabs, protection, readiness, rules, navGuard,
// downloads, evalBridge) or into a glue module with an injected minimal
// interface (webRequestFunnel atop contentBlocking, navigation, popup,
// downloadGating). What is left
// here is the ORDER of real Electron calls — and the parts of that order this
// workspace CAN prove are proven for real, against a spawned Electron binary,
// in browserLive.test.ts.
//
// ARCHITECTURE, AND WHAT WAS VERIFIED RATHER THAN ASSUMED:
//
// * `WebContentsView`, not `BrowserView`. package.json pins Electron ^43.4.1,
//   comfortably past the line where `WebContentsView` (composed into a
//   `BaseWindow.contentView` tree) is the documented replacement for the
//   soft-deprecated `BrowserView`. One view per page, exactly as one
//   `WKWebView` was one page. Live-verified: several views attach to one real
//   `BaseWindow` with distinct `webContents` ids.
//
// * ONE EPHEMERAL SESSION PER PAGE, named with a fresh `randomUUID()` and never
//   reused. `WKWebsiteDataStore.nonPersistentDataStore()` returns a NEW
//   in-memory store on every call, so every page in browser.rs is already
//   isolated from its neighbours as well as from disk; Electron's
//   `session.fromPartition(name)` returns the SAME session for the same name,
//   for the life of the process, so a name derived from the page id (which
//   restarts at "0" for each new room) would hand a fresh room's first page the
//   PREVIOUS room's in-memory cookies and storage — precisely the trace this
//   browser promises not to keep. A UUID cannot collide across rooms.
//   Live-verified: a partition WITHOUT `persist:` reports `isPersistent()`
//   false, and one WITH it reports true.
//
// * THE PAGE SCRIPT is registered as a session preload
//   (`registerPreloadScript({ type: "frame" })`) with
//   `nodeIntegrationInSubFrames: true`, which is Electron's documented "all your
//   preloads will load for every iframe" mechanism — the analogue of
//   `initialization_script_for_all_frames`. That flag is LOAD-BEARING and was
//   live-verified in both directions: with it, a sub-frame gets its own bridge
//   instance with its own `DOC_ID`; without it, a sub-frame gets nothing at all.
//   `contextIsolation` and `sandbox` both stay ON — a browser pointed at the
//   open web is the last place to weaken Electron's defaults — which is why
//   page.js exports through `contextBridge`; see its footer.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Session, WebContents, WebContentsView } from "electron";
import { registerWebRequestFunnel, type WebRequestFunnelDeps } from "./webRequestFunnel.js";
import { attachDownloadGating, type DownloadGatingDeps } from "./downloadGating.js";
import { attachNavigationGating, type NavigationDeps } from "./navigation.js";
import { attachPopupHandling } from "./popup.js";
import { PAGE_SCRIPT_PATH } from "./pageScript.js";
import { saneBounds, type Bounds } from "./tabs.js";
import type { Protection } from "./protection.js";
import type { EvalHost } from "./evalBridge.js";

/**
 * `require("electron")` resolved LAZILY, inside the one function that needs it,
 * rather than as a static top-level import — this workspace's established
 * convention, and keychain.ts's doc comment says exactly why: under plain Node
 * (which is how vitest runs every file here) the "electron" package's CJS entry
 * exports a plain PATH STRING, and a static `import { session } from "electron"`
 * fails to resolve a named export at module-evaluation time, breaking every
 * test that so much as imports the file transitively. Deferring it means this
 * only ever runs inside a real Electron main process.
 */
interface ElectronMain {
  session: { fromPartition(partition: string): Session };
  WebContentsView: new (options: { webPreferences: Record<string, unknown> }) => WebContentsView;
}

function electronMain(): ElectronMain {
  const mod = createRequire(import.meta.url)("electron") as Partial<ElectronMain>;
  if (!mod || typeof mod !== "object" || !mod.session || !mod.WebContentsView) {
    throw new Error("The private browser is only available inside a running Electron app.");
  }
  return mod as ElectronMain;
}

/** One page's live pieces. */
export interface LivePage {
  id: string;
  view: WebContentsView;
  contents: WebContents;
  webSession: Session;
  /** What attaching the content blocker to this page's session actually did.
   *  Recorded per page because the shield's verdict is the worst of them. */
  protection: Protection;
}

export interface CreatePageDeps {
  contentBlocking: WebRequestFunnelDeps;
  downloadGating: DownloadGatingDeps;
  navigation: NavigationDeps;
}

/** The window's view tree, as little of it as this module needs. */
export interface WindowContentView {
  addChildView(view: WebContentsView): void;
  removeChildView(view: WebContentsView): void;
}

/**
 * Build one page's real view, with everything attached BEFORE it can fetch
 * anything. Callers own the tab bookkeeping, mirroring how `create` separates
 * "build the webview" from "record the Page".
 *
 * THE ORDER IS THE POINT. The session is minted, the preload registered and the
 * blocker attached before the `WebContentsView` is constructed, and the view is
 * not told to load anything here at all — so the "opening burst of requests
 * went out with no content blocker attached" window that forces browser.rs to
 * park every page on `about:blank` cannot exist.
 */
export function createLivePage(id: string, deps: CreatePageDeps): LivePage {
  const electron = electronMain();
  // Never `persist:`-prefixed, never reused — see this module's header.
  const webSession = electron.session.fromPartition(`arcelle-browse-${randomUUID()}`);
  webSession.registerPreloadScript({ filePath: PAGE_SCRIPT_PATH, type: "frame" });

  // The verdict is RETURNED rather than journalled here: the caller opens the
  // browsing sitting when it records the page, and a line written before that
  // would be filed under no sitting at all — invisible to a Journal view that
  // defaults to "what just happened".
  const blocking = registerWebRequestFunnel(webSession, deps.contentBlocking);
  const protection: Protection = blocking.ok
    ? { state: "active" }
    : { state: "failed", reason: blocking.reason };

  attachDownloadGating(webSession, deps.downloadGating);

  const view = new electron.WebContentsView({
    webPreferences: {
      session: webSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Load-bearing: without it the preload never reaches a sub-frame.
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
    },
  });
  const contents = view.webContents;

  attachPopupHandling(contents);
  attachNavigationGating(contents, deps.navigation);

  return { id, view, contents, webSession, protection };
}

/** Attach a page's view to the window and position it. Port of the
 *  `window.add_child(...)` call in `create`. */
export function attachToWindow(
  windowContentView: WindowContentView,
  page: LivePage,
  bounds: Bounds,
): void {
  windowContentView.addChildView(page.view);
  reposition(page, bounds);
}

/** Move one page's view. Rounded to the integer `Rectangle` Electron's
 *  `View.setBounds` requires — CSS logical bounds are floats, Chromium's
 *  compositor bounds are not. */
export function reposition(page: LivePage, bounds: Bounds): void {
  const b = saneBounds(bounds);
  page.view.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });
}

/**
 * Remove and destroy one page's view. Its ephemeral session dies with it —
 * nothing else ever names that partition, which is what makes closing a page
 * destroy its data (and is why a background tab is PARKED rather than closed).
 *
 * `windowContentView` is nullable because the app window can be gone by the
 * time a room closes, and a page whose view could not be detached must still
 * have its renderer torn down — an orphaned WebContents holding a live session
 * is exactly the trace this browser promises not to keep.
 */
export function destroyLivePage(
  windowContentView: WindowContentView | null,
  page: LivePage,
): void {
  try {
    windowContentView?.removeChildView(page.view);
  } catch {
    // Already detached, or the window is going away underneath us.
  }
  if (!page.contents.isDestroyed()) page.contents.close();
}

/**
 * Ask the LIVE session whether it is really ephemeral, rather than trusting the
 * partition string. Port of `verify_one_ephemeral`.
 *
 * A real check, not a restatement of how the session was built, for the reason
 * the Rust doc comment gives: the failure is SILENT. On the Tauri side,
 * supplying a custom `WKWebViewConfiguration` makes wry ignore `incognito` and
 * fall back to the default, persistent store — a browser that looks private and
 * is not.
 *
 * `isPersistent()` is the direct analogue of
 * `websiteDataStore().isPersistent()`, and its answer for both partition shapes
 * was confirmed against a live Electron process. `getStoragePath()` is asked as
 * well and must agree: it is a different question (is anything backed on disk)
 * about the same fact, and two independent answers are what would catch a
 * future Electron reserving a path for a session that still calls itself
 * non-persistent.
 */
export function verifyPageEphemeral(page: LivePage): boolean {
  return !page.webSession.isPersistent() && page.webSession.getStoragePath() === null;
}

/**
 * The real `EvalHost` (see evalBridge.ts) — the one implementation of that
 * interface no test here can exercise.
 *
 * The expression is wrapped in `JSON.stringify(...)` so the wire is the JSON
 * TEXT the Rust side used, not a structured clone: a clone would introduce a
 * failure mode wry never had (a non-cloneable value rejecting the whole call),
 * and evalJson already knows exactly what to do with text — including what an
 * empty answer means. `false` for `userGesture` keeps an eval from being
 * mistaken for a user activation.
 */
export function evalHostFor(pages: ReadonlyMap<string, LivePage>): EvalHost {
  return {
    async evaluate(pageId: string, js: string): Promise<string> {
      const page = pages.get(pageId);
      if (!page || page.contents.isDestroyed()) {
        // No renderer to ask at all — the closest analogue to wry's dropped
        // completion handler, so it reads as EVAL_LOST through evalJson's
        // rejection handling rather than as a bespoke third failure mode.
        throw new Error("That page was closed while it was working.");
      }
      const result: unknown = await page.contents.executeJavaScript(
        `JSON.stringify(${js})`,
        false,
      );
      return typeof result === "string" ? result : "";
    },
  };
}
