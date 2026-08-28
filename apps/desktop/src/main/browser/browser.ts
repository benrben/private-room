// BROWSE-1: the private browser — a child view the agent can drive.
//
// Port of the public surface of src-tauri/src/browser.rs: `new_tab`,
// `select_tab`, `close_tab`, `ensure`, `close`, `bounds`/`set_bounds`,
// `tab_list`, `protection`/`retry_protection`, `verify_ephemeral`, the journal
// plumbing, and the agent transport (`call`, `call_async`, `wait_ready`).
//
// THE THREE INVARIANTS, and where each one lives now:
//
//  1. NOTHING ABOUT THE WEB IS PERSISTED. Every page gets its own never-reused,
//     never-`persist:`-prefixed session (webviewManager.ts), and
//     `verifyEphemeral` asserts that against the LIVE session rather than
//     trusting how it was built, because the failure is silent.
//
//  2. EVERYTHING THE AGENT DOES IS JOURNALLED — the web leaves no trace, the
//     agent's conduct leaves a complete one, inside the encrypted room
//     (journal.ts).
//
//  3. THE BROWSER IS NEVER A PATH TO THIS MAC. Three layers: the literal
//     public-URL check on every navigation (navigation.ts, and — see `ensure`
//     below — here as well), an off-thread DNS recheck for anything spelled as
//     a name, and private-range blocking at the network layer for the
//     sub-resources no navigation hook ever sees (contentBlocking.ts).
//
// WHAT IS AND IS NOT ELECTRON GLUE HERE. Exactly ONE thing in this file needs a
// running Electron app: building a page's real view, session and preload
// (`createLivePage`). Everything else — the tab cap REFUSING rather than
// evicting, which page inherits the screen when one closes, the guard on the
// `loadURL` path, aggregating the shield's verdict over the open pages, the
// re-attach loop behind "Try again" — is ordinary orchestration that decides
// things no other module decides, and an earlier revision of this file left all
// of it unpinned on the strength of being "glue". It was not: a mutation making
// the cap EVICT the oldest page, and one applying the heir rule to a background
// tab, both passed the entire suite. So `BrowserDeps.createPage` is an injected
// seam in the same shape as the rest of this port (`EvalHost`,
// `BlockingSessionLike`, `NavigatableContents`, `DownloadItemLike`), and
// browser.test.ts drives the real class through it. What genuinely cannot be
// reached from Node is still proven against a spawned Electron binary in
// browserLive.test.ts.
//
// NOT WIRED HERE (scope, not oversight): moving a finished download's staged
// file into an open ROOM belongs to the room/file-store subsystem, which is a
// different part of this migration. `BrowserDeps.importFinishedDownload` is the
// seam it plugs into.

import {
  MAX_TABS,
  PARKED,
  START_BLANK,
  TabRegistry,
  heirAfter,
  saneBounds,
  type Bounds,
  type Protection,
} from "./tabs.js";
import { worstProtection } from "./protection.js";
import {
  attachToWindow,
  createLivePage,
  destroyLivePage,
  evalHostFor,
  reposition as repositionPage,
  verifyPageEphemeral,
  type CreatePageDeps,
  type LivePage,
  type WindowContentView,
} from "./webviewManager.js";
import {
  callAsync as bridgeCallAsync,
  callPage,
  evalJson,
  markSuperseded,
  waitReady as bridgeWaitReady,
  type CallAsyncOptions,
} from "./evalBridge.js";
import { registerWebRequestFunnel, type WebRequestFunnelDeps } from "./webRequestFunnel.js";
import type { DownloadGatingDeps } from "./downloadGating.js";
import type { NavigationDeps } from "./navigation.js";
import { checkPublicHttpUrl } from "./guard.js";
import { journal as writeJournal, type JournalSink } from "./journal.js";
import type { BrowserTab } from "../../shared/apiTypes.js";

/** Budgets the agent tools drive these calls with. Same numbers the Rust
 *  command layer passes in. */
export const WAIT_READY_BUDGET_MS = 12_000;
export const OPEN_BUDGET_MS = 25_000;
export const ASYNC_ACT_BUDGET_MS = 60_000;

export interface BrowserDeps {
  /** Asked FRESH per page, never cached — matching `crate::main_window(app)`
   *  being looked up per call, because the app's one real window can in
   *  principle be replaced. `null` when it is gone. */
  windowContentView(): WindowContentView | null;
  journalSink: JournalSink;
  emit(event: string, payload: unknown): void;
  stagingDir(): string;
  ensureStagingDir(dir: string): void;
  removeStagedFile(stagedPath: string): Promise<void>;
  /** Swept on room close — anything still staged belongs to a crashed or
   *  abandoned download. */
  removeStagingDir(dir: string): Promise<void>;
  importFinishedDownload(stagedPath: string, name: string, url: string): Promise<{ name: string }>;
  /**
   * How one page's real, live pieces are built. The ONE part of this class that
   * needs a running Electron app, and therefore the one part that is injected;
   * defaults to webviewManager's `createLivePage`. Every other webviewManager
   * call below takes a `LivePage` and reads only its own fields, so a test that
   * supplies this supplies the whole page.
   */
  createPage?(id: string, pageDeps: CreatePageDeps): LivePage;
}

export class Browser {
  private readonly registry = new TabRegistry();
  private readonly pages = new Map<string, LivePage>();
  private currentBounds: Bounds | null = null;
  /** The user has taken the wheel: agent tools refuse until it is released.
   *  Truthfully refused, never silently queued. */
  takeover = false;

  constructor(private readonly deps: BrowserDeps) {}

  // ------------------------------------------------------------------ journal

  journal(kind: string, url: string, detail: string): void {
    writeJournal(this.deps.journalSink, this.registry.sessionId(), kind, url, detail);
  }

  private emitBlocked(url: string): void {
    this.deps.emit("browser-blocked", { url });
  }

  /** A browser whose blocker silently failed must not look identical to one
   *  where it is working. Written once, so both the create and the retry path
   *  say the same thing. */
  private journalBlockerVerdict(verdict: Protection): void {
    this.journal(
      "blocker",
      "",
      verdict.state === "active"
        ? "Content blocking active."
        : `Content blocking FAILED to load: ${"reason" in verdict ? verdict.reason : verdict.state}`,
    );
  }

  sessionId(): string {
    return this.registry.sessionId();
  }

  // ------------------------------------------------------------------- guards

  /**
   * The literal public-URL check, applied to a destination the AGENT or the
   * address bar supplies.
   *
   * THIS IS NOT REDUNDANT WITH navigation.ts. wry's `on_navigation` fired for
   * programmatic navigations too, so one hook covered every path; Electron
   * documents — and a live probe confirms — that neither `will-frame-navigate`
   * nor `will-redirect` fires for `webContents.loadURL`. Without this check the
   * agent path would be the one way into the browser with no gate on it at all.
   * The DNS-resolving half stays the caller's (`browse_guard_url`'s) job, as it
   * is in Rust.
   */
  private guardDestination(url: string): URL {
    let parsed: URL;
    if (url === START_BLANK) return new URL(START_BLANK);
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    try {
      checkPublicHttpUrl(url);
    } catch (e) {
      this.journal("blocked", url, "Navigation blocked: private or non-web address.");
      this.emitBlocked(url);
      throw e instanceof Error ? e : new Error(String(e));
    }
    return parsed;
  }

  // -------------------------------------------------------------- dependencies

  /**
   * The webRequest funnel's deps for one page — the count, journal and
   * event closures webRequestFunnel.ts's `registerWebRequestFunnel` needs,
   * built the same way `navigationDepsFor`/`downloadGatingDeps` already
   * close over `id` for their own layers.
   */
  private webRequestFunnelDepsFor(id: string): WebRequestFunnelDeps {
    return {
      recordedTopUrl: () => this.registry.recordedUrl(id),
      journal: (kind, url, detail) => this.journal(kind, url, detail),
      emitBlocked: (url) => this.emitBlocked(url),
      countBlocked: () => this.registry.bumpBlockedCount(id),
    };
  }

  private downloadGatingDeps(): DownloadGatingDeps {
    return {
      stagingDir: () => this.deps.stagingDir(),
      ensureStagingDir: (dir) => this.deps.ensureStagingDir(dir),
      isPublicHttpUrl: (url) => {
        try {
          checkPublicHttpUrl(url);
          return true;
        } catch {
          return false;
        }
      },
      journal: (kind, url, detail) => this.journal(kind, url, detail),
      emitBlocked: (url) => this.emitBlocked(url),
      emitDownloadResult: (payload) => this.deps.emit("browser-download", payload),
      emitDownloadOversize: (payload) => this.deps.emit("browser-download-oversize", payload),
      importFinishedDownload: (p, n, u) => this.deps.importFinishedDownload(p, n, u),
      removeStagedFile: (p) => this.deps.removeStagedFile(p),
    };
  }

  private navigationDepsFor(id: string): NavigationDeps {
    return {
      journal: (kind, url, detail) => this.journal(kind, url, detail),
      emitBlocked: (url) => this.emitBlocked(url),
      // Only ever called for a navigation Electron confirms is main-frame, so a
      // sub-frame can never define what this page IS.
      recordMainFrameUrl: (url) => this.registry.recordUrl(id, url),
    };
  }

  private evalHost() {
    return evalHostFor(this.pages);
  }

  private activeId(): string | null {
    const id = this.registry.active;
    return id ? id : null;
  }

  private requireActive(): string {
    const id = this.activeId();
    if (!id || !this.pages.has(id)) {
      throw new Error("The browser isn't open. Use browse_open first.");
    }
    return id;
  }

  // ----------------------------------------------------------------- lifecycle

  /** Open a page in a NEW tab and show it. Port of `new_tab` + `create`. */
  newTab(url: string): string {
    const parsed = this.guardDestination(url);
    // The cap REFUSES a ninth page rather than quietly closing one the user was
    // reading.
    if (this.registry.count() >= MAX_TABS) {
      throw new Error(
        `The private browser is limited to ${MAX_TABS} open pages — close one first.`,
      );
    }
    const windowContentView = this.deps.windowContentView();
    if (!windowContentView) throw new Error("The app window is gone.");

    const id = this.registry.nextId();
    const build = this.deps.createPage ?? createLivePage;
    const page = build(id, {
      contentBlocking: this.webRequestFunnelDepsFor(id),
      downloadGating: this.downloadGatingDeps(),
      navigation: this.navigationDepsFor(id),
    });

    // The agent can open a page from any area, so there may be no measured rect
    // yet. Such a page is PARKED until it has one, exactly like a background
    // tab: a child view is positioned on screen rather than clipped by a pane,
    // so sizing it to the window here would float a web page over the workspace.
    //
    // ATTACHED BEFORE THE PAGE IS RECORDED, exactly as `create` runs
    // `window.add_child(...)?` before `register_page`. A view that could not be
    // attached must not leave a row in the strip and a live renderer holding a
    // live session behind it — that orphan is the trace this browser promises
    // not to keep, and it would count against the tab cap forever. Attaching
    // fetches nothing (`loadURL`, below, is what starts a request), so nothing
    // goes out unblocked by moving this up.
    try {
      attachToWindow(windowContentView, page, saneBounds(this.currentBounds ?? PARKED));
    } catch (e) {
      destroyLivePage(windowContentView, page);
      throw e instanceof Error ? e : new Error(String(e));
    }
    this.pages.set(id, page);

    // Recorded BEFORE anything is loaded, exactly as `register_page` runs before
    // the navigation: a page not yet in the ledger has nowhere to keep a
    // verdict, and the blocker's verdict is already known by now. This is also
    // what OPENS the browsing sitting, so every line below carries it.
    this.registry.addPage({
      id,
      url: parsed.toString(),
      title: "",
      protection: page.protection,
      blockedCount: 0,
    });
    this.journalBlockerVerdict(page.protection);

    this.selectTab(id);
    this.load(page, parsed.toString());
    return id;
  }

  /** Navigate the ACTIVE page, opening the first page if none is open. Port of
   *  `ensure`. */
  ensure(url: string): void {
    const parsed = this.guardDestination(url);
    const id = this.activeId();
    const page = id ? this.pages.get(id) : undefined;
    if (!id || !page) {
      this.newTab(url);
      return;
    }
    // Stamp the outgoing document BEFORE navigating, so `waitReady` cannot
    // mistake the page we are leaving for the page we asked for.
    void markSuperseded(this.evalHost(), id);
    this.registry.recordUrl(id, parsed.toString());
    this.load(page, parsed.toString());
  }

  private load(page: LivePage, url: string): void {
    void page.contents.loadURL(url).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      this.journal("open", url, `The page could not be loaded: ${message}`);
    });
  }

  /** Show `id` and park every other page. Port of `select_tab`. */
  selectTab(id: string): void {
    if (!this.pages.has(id)) throw new Error("That page is no longer open.");
    this.registry.setActive(id);
    this.repositionAll();
  }

  /**
   * Port of `close_tab`. Closing a BACKGROUND tab must not move the user: the
   * heir rule answers "what shows now that the VISIBLE page is gone", and
   * running it for a tab that was not showing swapped the page in front of the
   * user for its neighbour while the strip still highlighted the tab they were
   * on.
   */
  closeTab(id: string): void {
    const page = this.pages.get(id);
    if (page) destroyLivePage(this.deps.windowContentView(), page);
    this.pages.delete(id);

    const closedTheVisiblePage = this.registry.active === id;
    const { at, remaining } = this.registry.dropPage(id);
    if (closedTheVisiblePage) this.registry.setActive(heirAfter(remaining, at));
    this.repositionAll();
  }

  /** Close EVERY page — room close and app quit, the two paths meant to destroy
   *  the session. Port of `close`. */
  close(): void {
    const windowContentView = this.deps.windowContentView();
    for (const page of this.pages.values()) {
      destroyLivePage(windowContentView, page);
    }
    this.pages.clear();
    this.registry.closeAll();
    this.takeover = false;
    void this.deps.removeStagingDir(this.deps.stagingDir()).catch(() => {});
  }

  // -------------------------------------------------------------------- bounds

  /** The rect the ACTIVE page occupies. `PARKED` until the browser area has
   *  mounted and measured once, which is also what it reads while the page is
   *  deliberately shrunk out of the way — the two are the same state and
   *  callers must treat them the same. */
  bounds(): Bounds {
    return saneBounds(this.currentBounds ?? PARKED);
  }

  setBounds(b: Bounds): void {
    this.currentBounds = saneBounds(b);
    this.repositionAll();
  }

  /** Put the active page at the reported rect and park the rest. This IS tab
   *  switching — no view is created or destroyed, so a background page keeps its
   *  scroll position, its form state and its session. Every page moves, not just
   *  the active one: a background view is positioned absolutely on screen, not
   *  clipped by any pane, so leaving it put would float it over the workspace
   *  after a resize. Port of `reposition`. */
  private repositionAll(): void {
    const bounds = this.bounds();
    const active = this.registry.active;
    for (const page of this.pages.values()) {
      repositionPage(page, page.id === active ? bounds : PARKED);
    }
  }

  // ---------------------------------------------------------------- protection

  /** What the whole browser's blocker is doing — worst page wins, and a browser
   *  with no pages is `unknown`, never `active`. Port of `protection`. */
  protection(): Protection {
    return worstProtection(
      this.registry
        .all()
        .filter((p) => this.pages.has(p.id))
        .map((p) => p.protection),
    );
  }

  /**
   * Re-attach the blocker to EVERY open page, without moving any of them. What
   * the shield's "Try again" runs. Port of `retry_protection`.
   *
   * This is a REAL re-attach, not a re-affirmation: Electron keeps at most one
   * `onBeforeRequest` listener per session and a second registration replaces
   * the first, so re-running it is idempotent and cannot double-block. Pages
   * already `active` are re-attached too, for the Rust reason — skipping them
   * would leave the verdict depending on which pages happened to be fine when
   * the user pressed the button.
   */
  retryProtection(): void {
    if (this.pages.size === 0) throw new Error("The browser isn't open.");
    for (const [id, page] of this.pages) {
      const blocking = registerWebRequestFunnel(page.webSession, this.webRequestFunnelDepsFor(id));
      const verdict: Protection = blocking.ok
        ? { state: "active" }
        : { state: "failed", reason: blocking.reason };
      page.protection = verdict;
      this.registry.setProtection(id, verdict);
      this.journalBlockerVerdict(verdict);
    }
  }

  /** Ask every LIVE session whether it is really ephemeral. Every OPEN page is
   *  asked, not only the one showing: the shield speaks for the whole browser,
   *  and a background tab that had somehow acquired a persistent store would be
   *  exactly as bad as the visible one. Port of `verify_ephemeral`. */
  verifyEphemeral(): boolean {
    if (this.pages.size === 0) throw new Error("The browser isn't open.");
    for (const page of this.pages.values()) {
      if (!verifyPageEphemeral(page)) return false;
    }
    return true;
  }

  // ----------------------------------------------------------------- tab strip

  tabList(): BrowserTab[] {
    return this.registry.tabList((id) => this.pages.has(id));
  }

  isOpen(): boolean {
    return this.activeId() !== null;
  }

  isBlank(): boolean {
    return this.registry.isBlank();
  }

  activeUrl(): string | undefined {
    const id = this.activeId();
    return id ? this.registry.recordedUrl(id) : undefined;
  }

  /**
   * How many real cancellations the webRequest funnel has made on the
   * ACTIVE page's session (webRequestFunnel.ts, tabs.ts's
   * `Page.blockedCount`) — `0` when no page is open, matching `activeUrl`'s
   * own shape rather than `protection()`'s worst-of-every-open-page one:
   * this is a fact about the page showing, like `url`/`title`, not a
   * whole-browser verdict.
   *
   * Read by `browserInfo()` (browseCommands.ts) onto `BrowserInfo.blockedCount`
   * — the poll the shield already runs, which is the only channel out of the
   * native layer.
   */
  blockedCount(): number {
    const id = this.activeId();
    return id ? this.registry.blockedCount(id) : 0;
  }

  /** Correct the ACTIVE page's record from the page script's own
   *  `location.href`, and take its `<title>` off the same poll. Port of
   *  `record_active_url`/`record_active_title`. */
  recordActiveUrl(url: string): void {
    this.registry.recordActiveUrl(url);
  }

  recordActiveTitle(title: string): void {
    this.registry.recordActiveTitle(title);
  }

  // --------------------------------------------------------------- eval bridge

  /** Port of `wait_ready`, against the ACTIVE page. */
  async waitReady(budgetMs: number = WAIT_READY_BUDGET_MS): Promise<void> {
    const id = this.requireActive();
    await bridgeWaitReady(this.evalHost(), id, () => this.registry.isBlank(), budgetMs);
  }

  /** Port of `call` — a SYNCHRONOUS page op on the page that is showing. */
  async call(op: string, args: unknown = {}): Promise<unknown> {
    return callPage(this.evalHost(), this.requireActive(), op, args);
  }

  /**
   * Port of `call_async`. EVERY hop addresses the page the op was STARTED on,
   * not the page that is showing when the hop runs — the user can select another
   * tab mid-batch, and against the active view the ticket then belongs to a
   * document that never heard of it.
   */
  async callAsync(
    op: string,
    args: unknown,
    budgetMs: number = ASYNC_ACT_BUDGET_MS,
    opts: CallAsyncOptions = {},
  ): Promise<unknown> {
    const id = this.requireActive();
    return bridgeCallAsync(this.evalHost(), id, op, args, budgetMs, () => this.registry.isBlank(), {
      // Rust's `journal(app, "act", "", "The page navigated while acting")`.
      // The model is told the page moved; invariant #2 says the user's own
      // record has to say so too.
      onNavigated: () => this.journal("act", "", "The page navigated while acting"),
      ...opts,
    });
  }

  /** Raw eval against the active page — port of `eval_json`, used by the info
   *  poll, which needs `evalLostToNavigation` to tell a navigation from a page
   *  that is genuinely not answering. */
  async eval(js: string): Promise<unknown> {
    return evalJson(this.evalHost(), this.requireActive(), js);
  }

  /** Capture the active page as PNG bytes for the browse_look tool. */
  async captureActivePage(): Promise<Buffer> {
    const page = this.pages.get(this.requireActive());
    if (!page) throw new Error("The browser isn't open.");
    const image = await page.contents.capturePage();
    return image.toPNG();
  }
}

export { START_BLANK, MAX_TABS };
