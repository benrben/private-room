// The funnel's OWN decisions: which cancellations become a journal line plus a
// `browser-blocked` event, which are only ever counted, and that the count runs
// for both reasons every time. `classifyRequest`'s policy itself is proven in
// rules.test.ts, the frame-tree seam in contentBlocking.test.ts, and that a
// registration really cancels a real request in browserLive.test.ts — none of
// that is re-tested here. That `browser.ts` really threads its own journal/emit/
// count closures down into this registration is proven in browser.test.ts, which
// is the only place a deps object built-but-never-passed would show up.

import { describe, expect, it, vi } from "vitest";
import type { OnBeforeRequestListenerDetails } from "electron";
import { registerWebRequestFunnel, type WebRequestFunnelDeps } from "./webRequestFunnel.js";
import type { BlockingSessionLike } from "./contentBlocking.js";

type Listener = (
  details: OnBeforeRequestListenerDetails,
  callback: (response: { cancel?: boolean }) => void,
) => void;

/** Carries `onHeadersReceived` as well, so a test can assert the funnel leaves
 *  that slot unclaimed — see the module header for why an inert handler there
 *  would be worse than none. */
interface FakeSession {
  webRequest: {
    onBeforeRequest(listener: Listener): void;
    onHeadersReceived(listener: unknown): void;
  };
}

function fakeSession(): {
  session: FakeSession;
  listener: () => Listener;
  registrations: () => number;
  headersHandlers: () => number;
} {
  let captured: Listener | null = null;
  let registrations = 0;
  let headersHandlers = 0;
  return {
    session: {
      webRequest: {
        onBeforeRequest(listener: Listener) {
          registrations += 1;
          captured = listener;
        },
        onHeadersReceived() {
          headersHandlers += 1;
        },
      },
    },
    listener: () => {
      if (!captured) throw new Error("no listener was registered");
      return captured;
    },
    registrations: () => registrations,
    headersHandlers: () => headersHandlers,
  };
}

function details(over: Partial<OnBeforeRequestListenerDetails>): OnBeforeRequestListenerDetails {
  return {
    url: "https://example.com/",
    resourceType: "xhr",
    frame: null,
    ...over,
  } as OnBeforeRequestListenerDetails;
}

/** A frame whose own URL is empty and whose top document is `topUrl` — the
 *  shape a live probe confirmed for a sub-resource of a committed page. */
function frame(topUrl: string): OnBeforeRequestListenerDetails["frame"] {
  return { url: "", top: { url: topUrl } } as unknown as OnBeforeRequestListenerDetails["frame"];
}

interface Recorder {
  deps: WebRequestFunnelDeps;
  journalled: Array<[string, string, string]>;
  emitted: string[];
  blockedCalls: number;
}

function recorder(recordedTopUrl: string | undefined = undefined): Recorder {
  const journalled: Array<[string, string, string]> = [];
  const emitted: string[] = [];
  let blockedCalls = 0;
  return {
    journalled,
    emitted,
    get blockedCalls() {
      return blockedCalls;
    },
    deps: {
      recordedTopUrl: () => recordedTopUrl,
      journal: (kind, url, detail) => journalled.push([kind, url, detail]),
      emitBlocked: (url) => emitted.push(url),
      countBlocked: () => {
        blockedCalls += 1;
      },
    },
  };
}

describe("registerWebRequestFunnel", () => {
  it("registers exactly one onBeforeRequest listener and claims no other hook", () => {
    // Both halves matter. One `onBeforeRequest` registration is the whole point
    // of the funnel; NO `onHeadersReceived` registration is the deliberate
    // decision recorded in this module's header — an inert CSP handler would sit
    // in that one-per-session slot and silently evict a real one later.
    const { session, registrations, headersHandlers } = fakeSession();
    expect(registerWebRequestFunnel(session, recorder().deps)).toEqual({ ok: true });
    expect(registrations()).toBe(1);
    expect(headersHandlers()).toBe(0);
  });

  it("journals + emits + counts a main-frame private-network block", () => {
    const { session, listener } = fakeSession();
    const rec = recorder();
    registerWebRequestFunnel(session, rec.deps);

    const cb = vi.fn();
    listener()(
      details({ url: "http://192.168.1.1/admin", resourceType: "mainFrame", frame: frame("") }),
      cb,
    );

    expect(cb).toHaveBeenCalledWith({ cancel: true });
    expect(rec.journalled).toEqual([
      ["blocked", "http://192.168.1.1/admin", "Navigation blocked: private or non-web address."],
    ]);
    expect(rec.emitted).toEqual(["http://192.168.1.1/admin"]);
    expect(rec.blockedCalls).toBe(1);
  });

  it("counts a sub-resource private-network block WITHOUT journalling or emitting", () => {
    // rules.ts's own motivating case: a page embedding
    // `<img src="http://localhost:11434/...">` against the user's own Ollama
    // daemon. Real defense in depth, not a fact about where the PERSON went —
    // journalling it would turn one page load into a browsing history of every
    // local probe it silently tried to fire.
    const { session, listener } = fakeSession();
    const rec = recorder("https://news.example/");
    registerWebRequestFunnel(session, rec.deps);

    const cb = vi.fn();
    listener()(
      details({
        url: "http://127.0.0.1:11434/api/delete",
        resourceType: "image",
        frame: frame("https://news.example/"),
      }),
      cb,
    );

    expect(cb).toHaveBeenCalledWith({ cancel: true });
    expect(rec.journalled).toEqual([]);
    expect(rec.emitted).toEqual([]);
    expect(rec.blockedCalls).toBe(1);
  });

  it("counts a third-party tracker block WITHOUT journalling or emitting", () => {
    const { session, listener } = fakeSession();
    const rec = recorder();
    registerWebRequestFunnel(session, rec.deps);

    const cb = vi.fn();
    listener()(
      details({
        url: "https://doubleclick.net/px.gif",
        resourceType: "image",
        frame: frame("https://news.example/"),
      }),
      cb,
    );

    expect(cb).toHaveBeenCalledWith({ cancel: true });
    expect(rec.journalled).toEqual([]);
    expect(rec.emitted).toEqual([]);
    expect(rec.blockedCalls).toBe(1);
  });

  it("does not cancel, count, journal or emit an allowed first-party sub-resource", () => {
    const { session, listener } = fakeSession();
    const rec = recorder("https://news.example/");
    registerWebRequestFunnel(session, rec.deps);

    const cb = vi.fn();
    listener()(
      details({
        url: "https://news.example/style.css",
        resourceType: "stylesheet",
        frame: frame("https://news.example/"),
      }),
      cb,
    );

    expect(cb).toHaveBeenCalledWith({ cancel: false });
    expect(rec.blockedCalls).toBe(0);
    expect(rec.journalled).toEqual([]);
    expect(rec.emitted).toEqual([]);
  });

  it("does not cancel, count, journal or emit a top-level navigation to a tracker's own site", () => {
    // The same invariant contentBlocking.test.ts pins directly on
    // attachContentBlocking: an ad rule must not refuse a top-level load of the
    // tracker's own site.
    const { session, listener } = fakeSession();
    const rec = recorder();
    registerWebRequestFunnel(session, rec.deps);

    const cb = vi.fn();
    listener()(
      details({ url: "https://doubleclick.net/", resourceType: "mainFrame", frame: frame("") }),
      cb,
    );

    expect(cb).toHaveBeenCalledWith({ cancel: false });
    expect(rec.blockedCalls).toBe(0);
    expect(rec.journalled).toEqual([]);
    expect(rec.emitted).toEqual([]);
  });

  it("counts every block on the same page, not just the first, and journals only the main-frame one", () => {
    const { session, listener } = fakeSession();
    const rec = recorder("https://news.example/");
    registerWebRequestFunnel(session, rec.deps);
    const cb = vi.fn();

    listener()(details({ url: "https://doubleclick.net/a.gif", resourceType: "image" }), cb);
    listener()(details({ url: "https://doubleclick.net/b.gif", resourceType: "image" }), cb);
    listener()(
      details({ url: "http://127.0.0.1:11434/", resourceType: "mainFrame", frame: frame("") }),
      cb,
    );

    expect(rec.blockedCalls).toBe(3);
    expect(rec.journalled).toEqual([
      ["blocked", "http://127.0.0.1:11434/", "Navigation blocked: private or non-web address."],
    ]);
    expect(rec.emitted).toEqual(["http://127.0.0.1:11434/"]);
  });

  it("still cancels, and still counts, when the JOURNAL throws under an in-flight request", () => {
    // The funnel's sinks are the ones that can really fail: the journal writes
    // into a room that can be closed underneath a request already in flight, and
    // `browser-blocked` goes to a window that can be gone. Neither may cost the
    // request its verdict — Chromium holds it open until the callback runs, so a
    // swallowed callback stalls the very load this funnel just refused.
    const { session, listener } = fakeSession();
    const rec = recorder();
    registerWebRequestFunnel(session, {
      ...rec.deps,
      journal: () => {
        throw new Error("room closed under us");
      },
    });

    const cb = vi.fn();
    expect(() =>
      listener()(
        details({ url: "http://192.168.1.1/admin", resourceType: "mainFrame", frame: frame("") }),
        cb,
      ),
    ).not.toThrow();
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    // Counted before the sink that failed, so the shield's number stays true to
    // what was actually cancelled.
    expect(rec.blockedCalls).toBe(1);
  });

  it("still cancels when the browser-blocked EMIT throws", () => {
    const { session, listener } = fakeSession();
    const rec = recorder();
    registerWebRequestFunnel(session, {
      ...rec.deps,
      emitBlocked: () => {
        throw new Error("Object has been destroyed");
      },
    });

    const cb = vi.fn();
    expect(() =>
      listener()(
        details({ url: "http://192.168.1.1/admin", resourceType: "mainFrame", frame: frame("") }),
        cb,
      ),
    ).not.toThrow();
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    expect(rec.blockedCalls).toBe(1);
    // The line the journal DID get is still there — one failing sink does not
    // erase the other's work.
    expect(rec.journalled).toHaveLength(1);
  });

  it("reports a registration that THREW as a failed verdict, same as the primitive it wraps", () => {
    const session: BlockingSessionLike = {
      webRequest: {
        onBeforeRequest() {
          throw new Error("webRequest unavailable");
        },
      },
    };
    expect(registerWebRequestFunnel(session, recorder().deps)).toEqual({
      ok: false,
      reason: "webRequest unavailable",
    });
  });

  it("re-registering on the same session replaces rather than stacks", () => {
    // What retryProtection() ("Try again") relies on: this module does NOT
    // dedupe or guard the second call, it re-registers and lets the platform's
    // one-listener contract discard the first — so a page cannot end up with two
    // listeners double-counting or double-journalling one request.
    const { session, listener, registrations } = fakeSession();
    const rec = recorder();
    registerWebRequestFunnel(session, rec.deps);
    registerWebRequestFunnel(session, rec.deps);
    expect(registrations()).toBe(2);

    const cb = vi.fn();
    listener()(
      details({ url: "http://127.0.0.1:11434/", resourceType: "mainFrame", frame: frame("") }),
      cb,
    );
    expect(rec.blockedCalls).toBe(1);
    expect(rec.journalled).toHaveLength(1);
  });
});
