import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { SealLockingOverlay, SealUnlockingOverlay } from "./SealOverlay";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

async function render(element: React.ReactElement) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SealOverlay", () => {
  it("announces the normal fabricated lock state accessibly", async () => {
    const host = await render(createElement(SealLockingOverlay));
    const note = host.querySelector('[role="status"]');

    expect(host.querySelector(".seal-locking-overlay")).not.toBeNull();
    expect(note?.className).toBe("seal-note");
    expect(note?.getAttribute("aria-live")).toBe("polite");
    expect(note?.textContent).toContain("Locking this room…");
    expect(host.querySelector(".seal-note-spinner")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("explains a slow fabricated lock and keeps the unlock veil decorative", async () => {
    const slowHost = await render(createElement(SealLockingOverlay, { slow: true }));
    expect(slowHost.querySelector('[role="status"]')?.className).toBe("seal-note is-slow");
    expect(slowHost.textContent).toContain("stopping recordings, letting jobs finish");

    const unlockHost = await render(createElement(SealUnlockingOverlay));
    const unlock = unlockHost.querySelector(".seal-unlocking");
    expect(unlock?.getAttribute("aria-hidden")).toBe("true");
  });
});
