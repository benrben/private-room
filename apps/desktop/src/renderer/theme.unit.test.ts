import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme, getTheme, getThemeChoice, initTheme, setTheme, systemTheme, toggleTheme } from "./theme";

const globalKeys = ["window", "document", "localStorage"] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type FakeStorage = {
  values: Map<string, string>;
  fail: boolean;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function install(matches = true, listenerThrows = false) {
  const parsed = parseHTML("<html><body></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const listeners: Array<() => void> = [];
  const media = {
    matches,
    addEventListener: vi.fn((_event: string, listener: () => void) => {
      if (listenerThrows) throw new Error("fake listener unsupported");
      listeners.push(listener);
    }),
  };
  const storage: FakeStorage = {
    values: new Map(),
    fail: false,
    getItem(key) {
      if (this.fail) throw new Error("fake storage read blocked");
      return this.values.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.fail) throw new Error("fake storage write blocked");
      this.values.set(key, value);
    },
    removeItem(key) {
      if (this.fail) throw new Error("fake storage delete blocked");
      this.values.delete(key);
    },
  };
  Reflect.set(window, "matchMedia", () => media);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "localStorage", storage);
  return { document, window, media, listeners, storage };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("theme preferences with fabricated DOM, media query, and storage APIs", () => {
  it("reads system and stored preferences defensively", () => {
    const view = install(true);
    expect(systemTheme()).toBe("dark");
    view.media.matches = false;
    expect(systemTheme()).toBe("light");
    Reflect.set(view.window, "matchMedia", () => { throw new Error("fake matchMedia unavailable"); });
    expect(systemTheme()).toBe("dark");

    view.storage.values.set("prTheme", "light");
    expect(getThemeChoice()).toBe("light");
    expect(getTheme()).toBe("light");
    view.storage.values.set("prTheme", "dark");
    expect(getThemeChoice()).toBe("dark");
    view.storage.values.set("prTheme", "not-a-theme");
    expect(getThemeChoice()).toBe("system");
    view.storage.fail = true;
    expect(getThemeChoice()).toBe("system");
  });

  it("applies, persists, and toggles explicit and system choices even when fake storage rejects persistence", () => {
    const view = install(true);
    expect(setTheme("light")).toBe("light");
    expect(view.storage.values.get("prTheme")).toBe("light");
    expect(view.document.documentElement.dataset.theme).toBe("light");
    expect(view.document.documentElement.style.backgroundColor).toBe("#f4f1e8");

    expect(setTheme("system")).toBe("dark");
    expect(view.storage.values.has("prTheme")).toBe(false);
    expect(view.document.documentElement.style.backgroundColor).toBe("#151716");
    view.storage.fail = true;
    expect(setTheme("light")).toBe("light");
    expect(view.document.documentElement.dataset.theme).toBe("light");

    view.storage.fail = false;
    view.storage.values.set("prTheme", "light");
    expect(toggleTheme()).toBe("dark");
    expect(view.storage.values.has("prTheme")).toBe(false);
    view.storage.values.set("prTheme", "dark");
    expect(toggleTheme()).toBe("light");
    expect(view.storage.values.get("prTheme")).toBe("light");
    applyTheme("dark");
    expect(view.document.documentElement.dataset.theme).toBe("dark");
  });

  it("tracks fabricated system changes only while the stored choice is system", () => {
    const view = install(false);
    initTheme();
    expect(view.document.documentElement.dataset.theme).toBe("light");
    expect(view.listeners).toHaveLength(1);
    view.media.matches = true;
    view.listeners[0]!();
    expect(view.document.documentElement.dataset.theme).toBe("dark");

    view.storage.values.set("prTheme", "light");
    applyTheme("light");
    view.listeners[0]!();
    expect(view.document.documentElement.dataset.theme).toBe("light");

    const unsupported = install(true, true);
    initTheme();
    expect(unsupported.document.documentElement.dataset.theme).toBe("dark");
  });
});
