import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({
  BookOpenIcon: () => null,
  CreateIcon: () => null,
  FolderIcon: () => null,
  GlobeIcon: () => null,
  GraphIcon: () => null,
  HomeIcon: () => null,
  LinkIcon: () => null,
  MemoryIcon: () => null,
  MicIcon: () => null,
  ScriptIcon: () => null,
  SketchIcon: () => null,
  WorkflowsIcon: () => null,
}));

import { DEFAULT_PINNED, defaultPrefs, loadPrefs, moveWithin, type NavPrefs } from "./navPrefs";

const originalStorage = Reflect.get(globalThis, "localStorage");

function useStorage(value: string | null, throws = false) {
  Reflect.set(globalThis, "localStorage", {
    getItem: () => {
      if (throws) throw new Error("private mode");
      return value;
    },
  });
}

afterEach(() => {
  if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Reflect.set(globalThis, "localStorage", originalStorage);
});

describe("loadPrefs", () => {
  it("returns shipped preferences for missing, inaccessible, malformed, or non-record storage", () => {
    useStorage(null);
    expect(loadPrefs()).toEqual(defaultPrefs());
    useStorage(null, true);
    expect(loadPrefs()).toEqual(defaultPrefs());
    useStorage("not json");
    expect(loadPrefs()).toEqual(defaultPrefs());
    useStorage("null");
    expect(loadPrefs()).toEqual(defaultPrefs());
  });

  it("drops retired areas, appends new ones, and preserves an explicit empty pinned choice", () => {
    useStorage(JSON.stringify({ order: ["files", "retired", "files"], pinned: [] }));
    const prefs = loadPrefs();
    expect(prefs.order.slice(0, 3)).toEqual(["files", "files", "home"]);
    expect(prefs.order).toContain("memory");
    expect(prefs.pinned).toEqual([]);
  });

  it("uses default pinned rows only when the old record has no pinned field", () => {
    useStorage(JSON.stringify({ order: ["sketch"] }));
    const prefs = loadPrefs();
    expect(prefs.order[0]).toBe("sketch");
    expect(prefs.pinned).toEqual(DEFAULT_PINNED);
  });
});

describe("moveWithin", () => {
  it("swaps pinned destinations by their pinned neighbors without moving More-tools rows", () => {
    const prefs: NavPrefs = {
      pinned: ["home", "files", "browser"],
      order: ["home", "memory", "files", "skills", "browser", "scripts"],
    };

    expect(moveWithin(prefs, "files", 1)).toEqual({
      ...prefs,
      order: ["home", "memory", "browser", "skills", "files", "scripts"],
    });
  });

  it("swaps More-tools destinations by their own neighbors without disturbing pins", () => {
    const prefs: NavPrefs = {
      pinned: ["home", "files"],
      order: ["home", "memory", "files", "skills", "scripts"],
    };

    expect(moveWithin(prefs, "skills", -1)).toEqual({
      ...prefs,
      order: ["home", "skills", "files", "memory", "scripts"],
    });
  });

  it("keeps the exact preference object for a missing or boundary destination", () => {
    const prefs: NavPrefs = {
      pinned: ["home", "files"],
      order: ["home", "memory", "files", "skills"],
    };

    expect(moveWithin(prefs, "home", -1)).toBe(prefs);
    expect(moveWithin(prefs, "skills", 1)).toBe(prefs);
    expect(moveWithin(prefs, "browser", 1)).toBe(prefs);
  });
});
