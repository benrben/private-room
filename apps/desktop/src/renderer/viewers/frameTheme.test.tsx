import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameIsDark, useFrameTheme, withFrameTheme } from "./frameTheme";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "HTMLElement",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
  "MutationObserver",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function installDom(theme?: "dark" | "light", matchDark = false) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  if (theme) document.documentElement.dataset.theme = theme;
  Object.assign(window, {
    matchMedia: vi.fn(() => ({ matches: matchDark })),
  });
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  return { document };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("frame theme", () => {
  it("reads a stamped app theme before its fabricated platform fallback", () => {
    Reflect.deleteProperty(globalThis, "document");
    expect(frameIsDark()).toBe(false);

    installDom("dark", false);
    expect(frameIsDark()).toBe(true);

    installDom("light", true);
    expect(frameIsDark()).toBe(false);

    installDom(undefined, true);
    expect(frameIsDark()).toBe(true);

    installDom(undefined, false);
    (globalThis.window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("fabricated media query failure");
    });
    expect(frameIsDark()).toBe(false);
  });

  it("stamps only unthemed dark frame markup", () => {
    installDom("light");
    expect(withFrameTheme("<html><body>light</body></html>")).toBe("<html><body>light</body></html>");

    installDom("dark");
    expect(withFrameTheme('<html data-theme="light"><body>chosen</body></html>'))
      .toBe('<html data-theme="light"><body>chosen</body></html>');
    expect(withFrameTheme("<html><body>dark</body></html>"))
      .toBe('<html data-theme="dark"><body>dark</body></html>');
    expect(withFrameTheme("<p>fragment</p>"))
      .toBe('<script>document.documentElement.dataset.theme="dark"</script><p>fragment</p>');
  });

  it("initializes a frame theme consumer from a fabricated light stamp", async () => {
    const { document } = installDom("light");
    class FakeMutationObserver {
      constructor(_callback: () => void) {}

      observe = vi.fn();
      disconnect = vi.fn();
    }
    Reflect.set(globalThis, "MutationObserver", FakeMutationObserver);
    const { createRoot } = await import("react-dom/client");
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const root = createRoot(host);
    const Probe = () => createElement("output", null, useFrameTheme());

    await act(async () => root.render(createElement(Probe)));
    expect(host.textContent).toBe("light");
    await act(async () => root.unmount());
  });

  it("updates a frame theme consumer when its fabricated document stamp changes", async () => {
    const { document } = installDom("dark");
    const callbacks: Array<() => void> = [];
    const disconnect = vi.fn();
    class FakeMutationObserver {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }

      observe = vi.fn();
      disconnect = disconnect;
    }
    Reflect.set(globalThis, "MutationObserver", FakeMutationObserver);
    const { createRoot } = await import("react-dom/client");
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const root = createRoot(host);
    const Probe = () => createElement("output", null, useFrameTheme());

    await act(async () => root.render(createElement(Probe)));
    expect(host.textContent).toBe("dark");

    document.documentElement.dataset.theme = "light";
    await act(async () => callbacks[0]?.());
    expect(host.textContent).toBe("light");

    await act(async () => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
