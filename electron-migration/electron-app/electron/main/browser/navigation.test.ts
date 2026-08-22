// The navigation gate's own decisions, against a fake `WebContents`.
//
// browser.rs can only pin this half as SOURCE SCANS (its own tests grep the
// function body for `recheck_host_off_thread` and `webview_of(app, id)`),
// because reaching the real paths needs a live webview. An injected minimal
// interface lets the same invariants be executed here instead.
//
// Every URL below is either an IP literal or `localhost`, so no test in this
// file performs a network DNS lookup: `needsHostRecheck` is false for a
// literal, and `localhost` resolves from the OS's own hosts file.

import { describe, expect, it, vi } from "vitest";
import {
  attachNavigationGating,
  gateNavigation,
  recheckHostOffThread,
  type NavigationDeps,
} from "./navigation.js";

function fakeDeps() {
  const journalled: Array<[string, string, string]> = [];
  const blocked: string[] = [];
  const recorded: string[] = [];
  const deps: NavigationDeps = {
    journal: (kind, url, detail) => journalled.push([kind, url, detail]),
    emitBlocked: (url) => blocked.push(url),
    recordMainFrameUrl: (url) => recorded.push(url),
  };
  return { deps, journalled, blocked, recorded };
}

function fakeContents() {
  const stop = vi.fn();
  return { stop, isDestroyed: () => false };
}

function attempt(url: string, isMainFrame = true) {
  const preventDefault = vi.fn();
  return { url, isMainFrame, preventDefault };
}

describe("navigation_allowed: the literal gate", () => {
  it("lets an ordinary public destination through and records it", () => {
    const { deps, recorded, blocked } = fakeDeps();
    const ev = attempt("http://8.8.8.8/page");
    gateNavigation(fakeContents(), ev, deps);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(recorded).toEqual(["http://8.8.8.8/page"]);
    expect(blocked).toEqual([]);
  });

  it("refuses a private address, journals it, and tells the interface", () => {
    const { deps, journalled, blocked, recorded } = fakeDeps();
    const ev = attempt("http://127.0.0.1:11434/api/delete");
    gateNavigation(fakeContents(), ev, deps);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(journalled).toEqual([
      ["blocked", "http://127.0.0.1:11434/api/delete", "Navigation blocked: private or non-web address."],
    ]);
    expect(blocked).toEqual(["http://127.0.0.1:11434/api/delete"]);
    // A refused destination is never what this page IS.
    expect(recorded).toEqual([]);
  });

  it("refuses a private SUB-FRAME navigation too", () => {
    // wry's hook fired for sub-frames and blocked them; keeping that means an
    // embedded frame cannot reach this Mac even before the content blocker
    // sees the request.
    const { deps, blocked } = fakeDeps();
    const ev = attempt("http://192.168.1.1/admin", false);
    gateNavigation(fakeContents(), ev, deps);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(blocked).toEqual(["http://192.168.1.1/admin"]);
  });

  it("treats an app-handoff link as an ordinary link, not a security incident", () => {
    const { deps, journalled, blocked } = fakeDeps();
    const ev = attempt("mailto:hello@example.com");
    gateNavigation(fakeContents(), ev, deps);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(journalled[0]?.[0]).toBe("open");
    expect(journalled[0]?.[2]).toContain("opens another app");
    // No red banner, and no "blocked" line in the permanent journal.
    expect(blocked).toEqual([]);
  });

  it("keeps the loud path for file:, data: and javascript: at top level", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<b>x", "javascript:alert(1)"]) {
      const { deps, journalled, blocked } = fakeDeps();
      const ev = attempt(url);
      gateNavigation(fakeContents(), ev, deps);
      expect(ev.preventDefault, url).toHaveBeenCalled();
      expect(journalled[0]?.[0], url).toBe("blocked");
      expect(blocked, url).toEqual([url]);
    }
  });

  it("never blocks a frame's own idle state", () => {
    // Blocking about:blank would break the page for real.
    const { deps, journalled, recorded } = fakeDeps();
    const ev = attempt("about:blank", false);
    gateNavigation(fakeContents(), ev, deps);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(journalled).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("leaves an unparseable destination to Chromium rather than inventing a verdict", () => {
    const { deps, journalled } = fakeDeps();
    const ev = attempt("!!!not a url!!!");
    gateNavigation(fakeContents(), ev, deps);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(journalled).toEqual([]);
  });
});

describe("only a MAIN-FRAME navigation may define what a page is", () => {
  it("records the main frame's destination", () => {
    const { deps, recorded } = fakeDeps();
    gateNavigation(fakeContents(), attempt("http://8.8.8.8/real", true), deps);
    expect(recorded).toEqual(["http://8.8.8.8/real"]);
  });

  it("never records a SUB-FRAME's, however plausible it looks", () => {
    // THE VANISHING-PAGE BUG: wry could not tell the two apart, so an iframe
    // overwrote the page's record. Electron hands over ground truth, so the
    // same-site heuristic is not needed for this job at all — a sub-frame
    // simply cannot touch the record.
    const { deps, recorded } = fakeDeps();
    gateNavigation(fakeContents(), attempt("http://8.8.8.8/ad-frame", false), deps);
    gateNavigation(fakeContents(), attempt("about:blank", false), deps);
    expect(recorded).toEqual([]);
  });
});

describe("recheck_host_off_thread / halt_private_navigation", () => {
  it("stops the page that navigated when a NAME turns out to point at this Mac", async () => {
    // The literal gate only reads the address TEXT; a perfectly ordinary name
    // can point at 127.0.0.1, and the content rules match text too, so they
    // cannot help either.
    const { deps, journalled, blocked } = fakeDeps();
    const contents = fakeContents();
    await recheckHostOffThread(contents, new URL("http://localhost/dashboard"), deps);
    expect(contents.stop).toHaveBeenCalledTimes(1);
    expect(journalled[0]?.[0]).toBe("blocked");
    expect(journalled[0]?.[2]).toContain("resolves to this Mac");
    expect(blocked).toEqual(["http://localhost/dashboard"]);
  });

  it("does not touch a destroyed page", async () => {
    const { deps } = fakeDeps();
    const stop = vi.fn();
    await recheckHostOffThread({ stop, isDestroyed: () => true }, new URL("http://localhost/"), deps);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not resolve an IP literal at all — the literal check already decided it", async () => {
    const { deps, journalled } = fakeDeps();
    const contents = fakeContents();
    await recheckHostOffThread(contents, new URL("http://8.8.8.8/"), deps);
    expect(contents.stop).not.toHaveBeenCalled();
    expect(journalled).toEqual([]);
  });
});

describe("attachNavigationGating", () => {
  it("listens on BOTH will-frame-navigate and will-redirect", () => {
    // A server-side 302 does not fire `will-frame-navigate` — confirmed against
    // a live Electron process, where a 302 produced exactly one event and it
    // was `will-redirect`. Without the second listener, a page answering
    // 302 -> http://127.0.0.1/ would walk straight past this gate.
    const events: string[] = [];
    const contents = {
      on(event: string) {
        events.push(event);
        return this;
      },
      stop: vi.fn(),
      isDestroyed: () => false,
    };
    attachNavigationGating(contents as never, fakeDeps().deps);
    expect(events.sort()).toEqual(["will-frame-navigate", "will-redirect"]);
  });

  it("gates a redirect exactly as it gates a click", () => {
    const listeners = new Map<string, (ev: unknown) => void>();
    const contents = {
      on(event: string, listener: (ev: unknown) => void) {
        listeners.set(event, listener);
        return this;
      },
      stop: vi.fn(),
      isDestroyed: () => false,
    };
    const { deps, blocked } = fakeDeps();
    attachNavigationGating(contents as never, deps);

    const ev = attempt("http://169.254.169.254/latest/meta-data");
    listeners.get("will-redirect")?.(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(blocked).toEqual(["http://169.254.169.254/latest/meta-data"]);
  });
});
