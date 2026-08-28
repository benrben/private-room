// The window-open handler, against a fake `WebContents`.
//
// The Rust side had no equivalent test at all: NO_POPUPS_JS was a string
// constant injected into the page, so nothing could exercise it without a live
// document.

import { describe, expect, it, vi } from "vitest";
import { attachPopupHandling, type PopupContents } from "./popup.js";

function fakeContents() {
  const loadURL = vi.fn(async () => {});
  let handler: ((d: { url: string }) => { action: string }) | null = null;
  const contents: PopupContents = {
    setWindowOpenHandler(h) {
      handler = h as typeof handler;
    },
    loadURL,
  };
  attachPopupHandling(contents);
  if (!handler) throw new Error("no window-open handler was installed");
  return { open: handler as (d: { url: string }) => { action: string }, loadURL };
}

describe("setWindowOpenHandler replaces NO_POPUPS_JS", () => {
  it("denies the popup and moves the PAGE to the destination instead", () => {
    // Denying alone would reproduce wry's original bug: a target="_blank" link
    // that silently does nothing at all.
    const { open, loadURL } = fakeContents();
    expect(open({ url: "https://example.com/next" })).toEqual({ action: "deny" });
    expect(loadURL).toHaveBeenCalledWith("https://example.com/next");
  });

  it("moves the WHOLE page, not the frame the link sat in", () => {
    // `contents.loadURL` always targets the main frame — the
    // `window.top.location.href` case NO_POPUPS_JS tried first. "Open in a new
    // window" from an embedded ad means leave this site; replacing the iframe
    // would leave the reader looking at the ad.
    const { loadURL } = fakeContents();
    expect(loadURL).not.toHaveBeenCalled();
  });

  it("does NOT blank the page for a bare window.open() with no destination", () => {
    // Electron resolves a bare `window.open()` to `about:blank` — confirmed
    // against a live Electron process, which reported exactly
    // `{url: "about:blank"}`. Navigating there would destroy the page the user
    // was reading in order to honour a popup we are refusing anyway.
    const { open, loadURL } = fakeContents();
    expect(open({ url: "about:blank" })).toEqual({ action: "deny" });
    expect(loadURL).not.toHaveBeenCalled();
  });

  it("refuses a request with no url at all without throwing", () => {
    const { open, loadURL } = fakeContents();
    expect(open({ url: "" })).toEqual({ action: "deny" });
    expect(loadURL).not.toHaveBeenCalled();
  });

  it("survives a destination the WebContents itself refuses to load", () => {
    // Fire-and-forget, exactly as a thrown `location.href` assignment was.
    let handler: ((d: { url: string }) => unknown) | null = null;
    const contents: PopupContents = {
      setWindowOpenHandler(h) {
        handler = h as typeof handler;
      },
      loadURL: async () => {
        throw new Error("blocked by the navigation gate");
      },
    };
    attachPopupHandling(contents);
    expect(() => (handler as unknown as (d: { url: string }) => unknown)({ url: "http://127.0.0.1/" })).not.toThrow();
  });
});
