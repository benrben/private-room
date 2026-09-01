import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  forgetSavedLayouts: vi.fn(),
  resetNavPrefs: vi.fn(),
}));

vi.mock("../shell/useLayout", () => ({ forgetSavedLayouts: mocks.forgetSavedLayouts }));
vi.mock("../shell/navPrefs", () => ({ resetNavPrefs: mocks.resetNavPrefs }));

import { initInterface, useInterfaceSettings } from "./useInterfaceSettings";

const { act, createElement } = React;
const globalKeys = ["document", "window", "localStorage", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

let values = new Map<string, string>();
let readFails = false;
let writeFails = false;

const storage = {
  getItem: vi.fn((key: string) => {
    if (readFails) throw new Error("fabricated unavailable preferences");
    return values.get(key) ?? null;
  }),
  removeItem: vi.fn((key: string) => {
    if (writeFails) throw new Error("fabricated unavailable preferences");
    values.delete(key);
  }),
  setItem: vi.fn((key: string, value: string) => {
    if (writeFails) throw new Error("fabricated unavailable preferences");
    values.set(key, value);
  }),
};

function installDom(): void {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  Reflect.set(globalThis, "window", parsed.window);
  Reflect.set(globalThis, "document", parsed.document);
  Reflect.set(globalThis, "HTMLElement", parsed.window.HTMLElement);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

beforeEach(() => {
  installDom();
  values = new Map();
  readFails = false;
  writeFails = false;
  storage.getItem.mockClear();
  storage.removeItem.mockClear();
  storage.setItem.mockClear();
  mocks.forgetSavedLayouts.mockReset();
  mocks.resetNavPrefs.mockReset();
});

afterEach(() => {
  for (const key of globalKeys) {
    const value = originalGlobals[key];
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("interface preferences", () => {
  it("applies saved, default, and unavailable preference values before React paints", () => {
    values.set("prDensity", "compact");
    values.set("prTexture", "off");
    initInterface();
    expect(document.documentElement.dataset).toMatchObject({ density: "compact", texture: "off" });

    values.set("prDensity", "unexpected");
    values.set("prTexture", "unexpected");
    initInterface();
    expect(document.documentElement.dataset.density).toBeUndefined();
    expect(document.documentElement.dataset.texture).toBeUndefined();

    readFails = true;
    initInterface();
    expect(document.documentElement.dataset.density).toBeUndefined();
    expect(document.documentElement.dataset.texture).toBeUndefined();
  });

  it("updates the shared preferences and resets every linked interface store despite write failures", async () => {
    values.set("prDensity", "compact");
    values.set("prTexture", "off");
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    let current: ReturnType<typeof useInterfaceSettings> | null = null;

    function Probe(): null {
      current = useInterfaceSettings();
      return null;
    }

    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(current).toMatchObject({ density: "compact", texture: "off" });

    await act(async () => {
      current?.setDensity("comfortable");
      current?.setTexture("subtle");
    });
    expect(storage.removeItem).toHaveBeenCalledWith("prDensity");
    expect(storage.removeItem).toHaveBeenCalledWith("prTexture");
    expect(document.documentElement.dataset.density).toBeUndefined();
    expect(document.documentElement.dataset.texture).toBeUndefined();

    writeFails = true;
    await act(async () => {
      current?.setDensity("compact");
      current?.setTexture("off");
    });
    expect(document.documentElement.dataset).toMatchObject({ density: "compact", texture: "off" });

    writeFails = false;
    await act(async () => {
      current?.resetAll();
    });
    expect(mocks.resetNavPrefs).toHaveBeenCalledOnce();
    expect(mocks.forgetSavedLayouts).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.density).toBeUndefined();
    expect(document.documentElement.dataset.texture).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });
});
