// The webRequest wiring's own decisions, against a fake `Session` that hands
// back the listener so it can be driven with real request shapes.
//
// Neither the policy (rules.test.ts) nor the fact that a registered listener
// really cancels a real request (browserLive.test.ts) is re-tested here. What
// IS only testable here is the seam between them: which URL this module hands
// `classifyRequest` as "the top-level page", which is where a top-level
// navigation to a listed domain would otherwise be cancelled.

import { describe, expect, it, vi } from "vitest";
import type { OnBeforeRequestListenerDetails } from "electron";
import {
  attachContentBlocking,
  resolveTopLevelUrl,
  type BlockingSessionLike,
  type ContentBlockingDeps,
} from "./contentBlocking.js";

type Listener = (
  details: OnBeforeRequestListenerDetails,
  callback: (response: { cancel?: boolean }) => void,
) => void;

function fakeSession(): { session: BlockingSessionLike; listener: () => Listener } {
  let captured: Listener | null = null;
  return {
    session: {
      webRequest: {
        onBeforeRequest(listener: Listener) {
          captured = listener;
        },
      },
    },
    listener: () => {
      if (!captured) throw new Error("no listener was registered");
      return captured;
    },
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

/** A `WebFrameMain`-shaped stand-in — only `.url` and `.top` are ever read. */
function frame(url: string, topUrl?: string): OnBeforeRequestListenerDetails["frame"] {
  const top = { url: topUrl ?? url };
  return { url, top } as unknown as OnBeforeRequestListenerDetails["frame"];
}

const noRecord: ContentBlockingDeps = { recordedTopUrl: () => undefined };

describe("resolveTopLevelUrl", () => {
  it("answers a mainFrame request with its OWN url", () => {
    // A live Electron probe showed `frame.top.url` is the EMPTY STRING for the
    // main-frame request of a fresh navigation — the frame has not committed
    // yet — so deriving it from the frame tree would make every top-level
    // navigation look third-party.
    const d = details({
      url: "https://doubleclick.net/",
      resourceType: "mainFrame",
      frame: frame("", ""),
    });
    expect(resolveTopLevelUrl(d, noRecord)).toBe("https://doubleclick.net/");
  });

  it("asks the frame tree for a sub-resource", () => {
    const d = details({
      url: "https://doubleclick.net/px.gif",
      resourceType: "image",
      frame: frame("", "https://news.example/article"),
    });
    expect(resolveTopLevelUrl(d, noRecord)).toBe("https://news.example/article");
  });

  it("falls back to the page's recorded url when the frame is gone", () => {
    // Electron's own caveat: `frame` may be null "if accessed after the frame
    // has either navigated or been destroyed".
    const d = details({ url: "https://doubleclick.net/px.gif", resourceType: "image", frame: null });
    expect(resolveTopLevelUrl(d, { recordedTopUrl: () => "https://news.example/" })).toBe(
      "https://news.example/",
    );
  });

  it("answers null when nothing knows, so the request is treated as third-party", () => {
    const d = details({ url: "https://doubleclick.net/px.gif", resourceType: "image", frame: null });
    expect(resolveTopLevelUrl(d, noRecord)).toBeNull();
  });

  it("survives a destroyed frame that THROWS rather than answering", () => {
    const throwing = {
      get url(): string {
        throw new Error("frame destroyed");
      },
      get top(): never {
        throw new Error("frame destroyed");
      },
    } as unknown as OnBeforeRequestListenerDetails["frame"];
    const d = details({ url: "https://x.example/a.gif", resourceType: "image", frame: throwing });
    expect(resolveTopLevelUrl(d, { recordedTopUrl: () => "https://news.example/" })).toBe(
      "https://news.example/",
    );
  });
});

describe("attachContentBlocking", () => {
  it("cancels a private-range sub-resource and reports why", () => {
    const { session, listener } = fakeSession();
    const blocked: Array<[string, string]> = [];
    const result = attachContentBlocking(session, {
      recordedTopUrl: () => "https://news.example/",
      onBlocked: (url, reason) => blocked.push([url, reason]),
    });
    expect(result).toEqual({ ok: true });

    const cb = vi.fn();
    listener()(
      details({ url: "http://127.0.0.1:11434/api/delete", resourceType: "image" }),
      cb,
    );
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    expect(blocked).toEqual([["http://127.0.0.1:11434/api/delete", "private-network"]]);
  });

  it("cancels a third-party tracker and lets the page's own resources through", () => {
    const { session, listener } = fakeSession();
    attachContentBlocking(session, { recordedTopUrl: () => "https://news.example/" });
    const cb = vi.fn();

    listener()(
      details({
        url: "https://doubleclick.net/px.gif",
        resourceType: "image",
        frame: frame("", "https://news.example/"),
      }),
      cb,
    );
    expect(cb).toHaveBeenLastCalledWith({ cancel: true });

    listener()(
      details({
        url: "https://news.example/style.css",
        resourceType: "stylesheet",
        frame: frame("", "https://news.example/"),
      }),
      cb,
    );
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
  });

  it("does NOT cancel a top-level navigation to a tracker's own site", () => {
    const { session, listener } = fakeSession();
    attachContentBlocking(session, noRecord);
    const cb = vi.fn();
    listener()(
      details({ url: "https://doubleclick.net/", resourceType: "mainFrame", frame: frame("", "") }),
      cb,
    );
    expect(cb).toHaveBeenCalledWith({ cancel: false });
  });

  it("always answers the callback, so no request is left hanging", () => {
    const { session, listener } = fakeSession();
    attachContentBlocking(session, noRecord);
    const cb = vi.fn();
    for (const url of ["not a url", "data:text/plain,x", "https://example.com/"]) {
      listener()(details({ url }), cb);
    }
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("reports a registration that THREW as a failed verdict, never as protected", () => {
    // The one failure mode Chromium leaves: the shield must not read a browser
    // whose blocker never attached as identical to one where it did.
    const session: BlockingSessionLike = {
      webRequest: {
        onBeforeRequest() {
          throw new Error("webRequest unavailable");
        },
      },
    };
    expect(attachContentBlocking(session, noRecord)).toEqual({
      ok: false,
      reason: "webRequest unavailable",
    });
  });
});
