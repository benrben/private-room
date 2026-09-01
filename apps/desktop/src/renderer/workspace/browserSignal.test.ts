import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserPageSignal } from "./browserSignal";

type BrowserSignal = typeof import("./browserSignal");

async function loadSignal(): Promise<BrowserSignal> {
  return import("./browserSignal");
}

const page: BrowserPageSignal = {
  url: "https://example.test/page",
  title: "Example page",
  readable: true,
  hasSelection: false,
};

beforeEach(() => {
  vi.resetModules();
});

describe("browser page signal", () => {
  it("publishes only fabricated state changes and retains the existing equal snapshot", async () => {
    const signal = await loadSignal();
    const fire = vi.fn();
    const unsubscribe = signal.subscribeBrowserPage(fire);

    signal.publishBrowserPage(null);
    expect(signal.browserPageSnapshot()).toBeNull();
    expect(fire).not.toHaveBeenCalled();

    signal.publishBrowserPage(page);
    expect(signal.browserPageSnapshot()).toBe(page);
    expect(fire).toHaveBeenCalledOnce();

    signal.publishBrowserPage({ ...page });
    expect(signal.browserPageSnapshot()).toBe(page);
    expect(fire).toHaveBeenCalledOnce();

    for (const changed of [
      { ...page, url: "https://example.test/other" },
      { ...page, title: "Other title" },
      { ...page, readable: false },
      { ...page, hasSelection: true },
    ]) {
      signal.publishBrowserPage(changed);
      expect(signal.browserPageSnapshot()).toBe(changed);
    }
    expect(fire).toHaveBeenCalledTimes(5);

    unsubscribe();
    signal.publishBrowserPage(null);
    expect(fire).toHaveBeenCalledTimes(5);
  });

  it("treats duplicate fabricated subscriptions as one listener and removes it", async () => {
    const signal = await loadSignal();
    const fire = vi.fn();
    const first = signal.subscribeBrowserPage(fire);
    const second = signal.subscribeBrowserPage(fire);

    signal.publishBrowserPage(page);
    expect(fire).toHaveBeenCalledOnce();

    first();
    signal.publishBrowserPage({ ...page, title: "changed" });
    expect(fire).toHaveBeenCalledOnce();
    second();
  });
});
